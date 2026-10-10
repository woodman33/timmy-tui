/**
 * Timmy VoxVision (round R4, helper H49): the supported tools, whether each can run here (and if not, its exact setup
 * step), how each is run, and how what each reports becomes labelled metrics. Nothing here runs a job; src/repl/vox.ts
 * does, as /observe runs Look. Readiness is said from configuration and the files present, never by running anything:
 * found is not working, and only an action's record says whether a tool ran.
 *
 *   tool      reads                     runs                                                       needs
 *   look      images                    workers/look/look.py --vox detect|diff (OpenCV)            a Python with cv2 and numpy
 *   stl       .stl                      src/native/stl-readback.ts, in Timmy's own process         nothing
 *   step      .step/.stp                workers/readback/step_readback.py (OCP)                    TIMMY_CADQUERY_PYTHON
 *   blend     .blend                    blender -b … --python workers/readback/blend_readback.py   Blender
 *   video     MP4, MOV, WebM            workers/readback/video_readback.py (ffprobe, ffmpeg)       python3, ffprobe, ffmpeg
 *   spatial   ASCII Gaussian-splat PLY  src/vision/spatial/gaussian-ply-context.ts, in process     nothing
 *   geo       two PLYs (truth, pred)    lanes/geo/voxel_score.py                                   python3 with numpy, scipy
 *   roboflow  images                    scripts/roboflow-bridge.py in the project's venv          ROBOFLOW_API_KEY, the venv
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AE_FFMPEG_SETUP, VIDEO_READBACK_SCRIPT, type VideoReadback } from '../flows/iterate-ae.js';
import { BLEND_READBACK_SCRIPT, type BlendReadback } from '../flows/iterate-blender.js';
import { READBACK_SCRIPT, type ReadbackMeasured } from '../flows/iterate.js';
import { locateNative, NATIVE_APPS } from '../native/index.js';
import { STL_READBACK, topologyWords, volumeWords, type StlReadback } from '../native/stl-readback.js';
import { nativeRuntime } from '../recipes/index.js';
import { packagedPath, packageRoot } from '../utils/asset-dirs.js';
import { LOOK_SCRIPT, lookPython, OPENCV_SETUP, type LookObservation } from '../vision/look.js';
import type { VoxKind, VoxTool } from './kinds.js';
import { delta, LABEL, num, ratio, TIER, type VoxAction, type VoxClaim, type VoxMetric } from './record.js';

export interface ToolEnv { env: NodeJS.ProcessEnv; onPath: (cmd: string) => string | null; root: string }
export type Readiness = { ready: true; command: string; via: string; extra?: Record<string, string> } | { ready: false; why: string; setup: string };

function packaged(rel: string): string {
  return packagedPath(rel, import.meta.url, { kind: 'file' }) ?? join(packageRoot(import.meta.url) ?? fileURLToPath(new URL('.', import.meta.url)), rel);
}
/** The geo lane's scorer and the Roboflow bridge, at the package root (a checkout carries them; the npm package does not). */
export const GEO_SCRIPT = packaged('lanes/geo/voxel_score.py');
export const ROBOFLOW_BRIDGE = packaged('scripts/roboflow-bridge.py');

/** Each tool's exact setup step, as a "needs setup" row says it. */
export const SETUP = {
  look: `${OPENCV_SETUP}, or set TIMMY_VISION_PYTHON to the absolute path of a Python that has OpenCV`,
  step: 'set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery (its OCP reads the STEP)',
  blend: NATIVE_APPS.blender.setup,
  video: AE_FFMPEG_SETUP,
  python: 'install Python 3, so that python3 is on the PATH',
  geo: 'python3 -m pip install numpy scipy',
  geoLane: 'run Timmy from a checkout of its repository: the geo lane (lanes/geo/voxel_score.py) is not in the npm package',
  roboflowKey: 'set ROBOFLOW_API_KEY (console.roboflow.com)',
  roboflowVenv: 'python3 -m venv .timmy/venv-roboflow && .timmy/venv-roboflow/bin/pip install roboflow inference-sdk',
  roboflowBridge: 'run Timmy from a checkout of its repository: the Roboflow bridge (scripts/roboflow-bridge.py) is not in the npm package',
  worker: 'reinstall Timmy: one of its workers is missing',
} as const;

const runnable = (file: string): boolean => { try { if (!statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true; } catch { return false; } };

export function lookReady(t: ToolEnv): Readiness {
  const py = lookPython(t.env, t.onPath);
  if ('error' in py) return { ready: false, why: `Look needs a Python with OpenCV: ${py.error}`, setup: SETUP.look };
  if (!existsSync(LOOK_SCRIPT)) return { ready: false, why: 'the Look worker (workers/look/look.py) is missing from this Timmy', setup: SETUP.worker };
  return { ready: true, command: py.python, via: py.from === 'PATH' ? 'python3 on the PATH' : `set by ${py.from}` };
}

export function stepReady(t: ToolEnv): Readiness {
  const rt = nativeRuntime(t.env);
  if (!rt.ok) return { ready: false, why: rt.why, setup: SETUP.step };
  if (!existsSync(READBACK_SCRIPT)) return { ready: false, why: 'the STEP readback worker (workers/readback/step_readback.py) is missing from this Timmy', setup: SETUP.worker };
  return { ready: true, command: rt.python, via: 'set by TIMMY_CADQUERY_PYTHON' };
}

export function blendReady(t: ToolEnv): Readiness {
  const located = locateNative('blender', t.env);
  if (!located.found) return { ready: false, why: `Blender was not found${located.problem ? ` (${located.problem})` : ''}`, setup: SETUP.blend };
  if (!existsSync(BLEND_READBACK_SCRIPT)) return { ready: false, why: 'the .blend readback worker (workers/readback/blend_readback.py) is missing from this Timmy', setup: SETUP.worker };
  const how = located.found.how === 'env' ? 'set by TIMMY_BLENDER' : located.found.how === 'applications' ? 'in /Applications' : 'on the PATH';
  return { ready: true, command: located.found.path, via: how };
}

/** python3, ffprobe and ffmpeg for the video readback (TIMMY_FFPROBE and TIMMY_FFMPEG first, as the worker reads them). */
export function videoReady(t: ToolEnv): Readiness {
  if (!existsSync(VIDEO_READBACK_SCRIPT)) return { ready: false, why: 'the video readback worker (workers/readback/video_readback.py) is missing from this Timmy', setup: SETUP.worker };
  const python = t.onPath('python3');
  if (!python) return { ready: false, why: 'no python3 on the PATH (the video readback is a Python 3 script)', setup: SETUP.python };
  const why: string[] = [];
  for (const tool of ['ffprobe', 'ffmpeg'] as const) {
    const v = `TIMMY_${tool.toUpperCase()}`;
    const given = t.env[v]?.trim();
    if (given) { if (!runnable(given)) why.push(`${v} is set, but nothing runnable is there`); }
    else if (!t.onPath(tool)) why.push(`${tool} is not on the PATH and ${v} is not set`);
  }
  if (why.length) return { ready: false, why: why.join('; '), setup: SETUP.video };
  return { ready: true, command: python, via: 'python3, ffprobe and ffmpeg found' };
}

export function geoReady(t: ToolEnv): Readiness {
  if (!existsSync(GEO_SCRIPT)) return { ready: false, why: 'the geo lane (lanes/geo/voxel_score.py) is not in this Timmy', setup: SETUP.geoLane };
  const python = t.onPath('python3');
  if (!python) return { ready: false, why: 'no python3 on the PATH (the geo lane is a Python 3 script)', setup: SETUP.python };
  return { ready: true, command: python, via: 'python3 on the PATH' };
}

/** The project's Roboflow venv, as src/utils/roboflow-adapter.ts finds it. */
export function roboflowReady(t: ToolEnv): Readiness {
  if (!t.env.ROBOFLOW_API_KEY) return { ready: false, why: 'needs ROBOFLOW_API_KEY', setup: SETUP.roboflowKey };
  const modern = join(t.root, '.timmy', 'venv-vision', 'bin', 'python');
  const venv = existsSync(modern) ? modern : join(t.root, '.timmy', 'venv-roboflow', 'bin', 'python');
  if (!existsSync(venv)) return { ready: false, why: "the project's Roboflow venv is missing (.timmy/venv-roboflow)", setup: SETUP.roboflowVenv };
  if (!existsSync(ROBOFLOW_BRIDGE)) return { ready: false, why: 'the Roboflow bridge (scripts/roboflow-bridge.py) is not in this Timmy', setup: SETUP.roboflowBridge };
  return { ready: true, command: venv, via: "the project's venv" };
}

/** What the board's tools panel says of each tool: built in, found (not run until an action uses it), or needs setup. */
export interface ToolStatus { tool: VoxTool; name: string; reads: string; state: 'built in' | 'found' | 'needs setup'; detail: string; setup?: string }
export function toolStatuses(t: ToolEnv): ToolStatus[] {
  const row = (tool: VoxTool, name: string, reads: string, r: Readiness, found: string): ToolStatus => (r.ready
    ? { tool, name, reads, state: 'found', detail: `${r.via}; ${found}` }
    : { tool, name, reads, state: 'needs setup', detail: r.why, setup: r.setup });
  return [
    { tool: 'stl', name: "Timmy's STL reader", reads: 'STL meshes', state: 'built in', detail: 'TypeScript, in Timmy\'s own process: bounding box, area, volume, edge checks' },
    { tool: 'spatial', name: 'the spatial module', reads: 'ASCII Gaussian-splat PLY', state: 'built in', detail: 'vertex count and centre bounds, in Timmy\'s own process; other PLY files: their header only' },
    row('look', 'Look (OpenCV)', 'images', lookReady(t), 'OpenCV is checked when an action runs'),
    row('step', 'the STEP readback (OCP)', 'STEP files', stepReady(t), 'OCP is checked when a readback runs'),
    row('blend', 'the .blend readback (Blender)', '.blend files', blendReady(t), 'found is not run: a readback says whether it works'),
    row('video', 'the video readback (ffprobe, ffmpeg)', 'videos', videoReady(t), 'run when an action reads a video'),
    row('geo', 'the geo lane (voxel_score.py)', 'two PLY point clouds', geoReady(t), 'exit 3 says when numpy or scipy is missing'),
    row('roboflow', 'Roboflow (hosted model)', 'images, as a model\'s prediction', roboflowReady(t), 'a network call to Roboflow, made only when /detect asks for it'),
  ];
}

// ── metrics ────────────────────────────────────────────────────────────────────

type Of = { of?: 'a' | 'b' };
const ofPart = (of?: 'a' | 'b'): Of => (of ? { of } : {});

const LOOK_TITLE: Record<string, string> = {
  mean_color: 'Mean colour', dominant_colors: 'Dominant colours', sharpness: 'Sharpness', edge_density: 'Edge density',
  qr_codes_decoded: 'QR codes decoded', aruco_markers: 'ArUco markers',
};
const LOOK_METHOD: Record<string, string> = {
  mean_color: 'the mean of the stored pixel values (visible pixels only when there is alpha), read as sRGB',
  dominant_colors: 'k-means on an evenly spaced sample of the pixels, with a fixed seed',
  sharpness: 'the variance of the Laplacian of the grayscale image',
  edge_density: 'the share of Canny edge pixels (thresholds 100 and 200) in the grayscale image',
  qr_codes_decoded: "OpenCV's QRCodeDetector (detectAndDecodeMulti, then detectAndDecode); only decoded codes count",
  aruco_markers: "OpenCV's ArUco detector, dictionary DICT_4X4_50",
};
/** The words /measure <image> takes, and the Look measurements each selects. */
export const IMAGE_SELECT: Readonly<Record<string, string[]>> = {
  size: ['width', 'height', 'channels'], color: ['mean_color', 'dominant_colors'], colour: ['mean_color', 'dominant_colors'], colors: ['mean_color', 'dominant_colors'],
  colours: ['mean_color', 'dominant_colors'], sharpness: ['sharpness'], edges: ['edge_density'], qr: ['qr_codes_decoded'], aruco: ['aruco_markers'],
};

export const lookBy = (o: Pick<LookObservation, 'worker' | 'opencv' | 'python'>): string => `${o.worker.name} ${o.worker.version} (OpenCV ${o.opencv}, Python ${o.python})`;

/** Look's observation as metrics: /inspect gets the facts (size, channels, codes found), the others every measurement. */
export function lookMetrics(o: LookObservation, action: VoxAction, select?: ReadonlySet<string>, of?: 'a' | 'b'): VoxMetric[] {
  const by = lookBy(o);
  const base = { tier: TIER.computed, label: LABEL.look, measured_by: by, ...ofPart(of) };
  const decoded = 'as decoded by OpenCV (cv2.imdecode, unchanged)';
  const out: VoxMetric[] = [
    { name: 'width', title: 'Width', value: o.image.width, unit: 'px', method: decoded, ...base },
    { name: 'height', title: 'Height', value: o.image.height, unit: 'px', method: decoded, ...base },
    { name: 'channels', title: 'Channels', value: o.image.channels, method: decoded, ...base },
  ];
  for (const m of o.measurements) {
    if (action === 'inspect' && m.name !== 'qr_codes_decoded' && m.name !== 'aruco_markers') continue;
    const list = Array.isArray(m.value) ? m.value as Array<Record<string, unknown>> : null;
    // /inspect says how many codes and markers were found; the others carry what was found (texts, ids, corners).
    const value = action === 'inspect' ? (list ? list.length : null) : m.value;
    out.push({
      name: m.name, title: action === 'inspect' ? `${LOOK_TITLE[m.name] ?? m.name} (count)` : LOOK_TITLE[m.name] ?? m.name, value,
      ...(action === 'inspect' ? (list ? { unit: 'found' } : {}) : m.unit ? { unit: m.unit } : {}),
      method: LOOK_METHOD[m.name] ?? 'as the Look worker reports it', ...base, ...(m.note ? { note: m.note } : {}),
    });
  }
  return select ? out.filter((x) => select.has(x.name)) : out;
}

/** The colour region Look measured (--vox detect --color), as one metric. */
export function colorRegionMetric(region: Record<string, unknown>, by: string, of?: 'a' | 'b'): VoxMetric {
  return {
    name: 'color_region', title: 'Colour region', value: region.value ?? null, unit: typeof region.unit === 'string' ? region.unit : 'pixels',
    method: typeof region.method === 'string' ? region.method : 'pixels within a colour tolerance', tier: TIER.computed, label: LABEL.look, measured_by: by,
    ...ofPart(of), ...(typeof region.note === 'string' ? { note: region.note } : {}),
  };
}

/** The pixel difference Look measured (--vox diff), as one metric. */
export function differenceMetric(diff: Record<string, unknown>, by: string): VoxMetric {
  return {
    name: 'pixel_difference', title: 'Pixel difference (b − a)', value: diff.value ?? null, unit: typeof diff.unit === 'string' ? diff.unit : '8-bit levels',
    method: typeof diff.method === 'string' ? diff.method : 'per-pixel channel differences', tier: TIER.computed, label: LABEL.look, measured_by: by, of: 'delta',
    ...(typeof diff.note === 'string' ? { note: diff.note } : {}),
  };
}

const STL_UNIT = 'file units';

/** Timmy's STL reading as metrics: /inspect the facts, the others every measure. */
export function stlMetrics(r: StlReadback, action: VoxAction, of?: 'a' | 'b'): VoxMetric[] {
  const base = { tier: TIER.computed, label: LABEL.stl, measured_by: `${STL_READBACK} (Timmy's TypeScript reader)`, ...ofPart(of) };
  const m = (name: string, title: string, value: unknown, method: string, unit?: string, note?: string): VoxMetric => ({ name, title, value, ...(unit ? { unit } : {}), method, ...base, ...(note ? { note } : {}) });
  const size = r.bbox?.size ?? null;
  const facts: VoxMetric[] = [
    m('format', 'STL encoding', r.format, 'binary when the size is exactly 84 + 50 × the declared triangle count; ASCII when it starts with "solid"'),
    m('triangles', 'Triangles', r.triangles, 'counted while parsing'),
    m('corners', 'Distinct corners', r.corners, r.joining),
    m('bbox_size', 'Bounding box size', size, r.methods.bbox, STL_UNIT, r.units),
    m('topology', 'Topology', topologyWords(r), r.methods.edges),
  ];
  if (action === 'inspect') return facts;
  return [
    ...facts.filter((x) => x.name !== 'topology'),
    m('bbox_min', 'Bounding box min', r.bbox?.min ?? null, r.methods.bbox, STL_UNIT),
    m('bbox_max', 'Bounding box max', r.bbox?.max ?? null, r.methods.bbox, STL_UNIT),
    m('area', 'Surface area', r.area, r.methods.area, `${STL_UNIT}²`),
    m('volume', 'Volume (signed)', r.volume, r.methods.volume, `${STL_UNIT}³`, volumeWords(r)),
    m('manifold', 'Edge-manifold', r.manifold, r.methods.edges),
    m('oriented', 'Consistently oriented', r.oriented, r.methods.edges),
    m('boundary_edges', 'Boundary edges', r.boundary_edges, r.methods.edges),
    m('non_manifold_edges', 'Non-manifold edges', r.non_manifold_edges, r.methods.edges),
    m('misoriented_edges', 'Misoriented edges', r.misoriented_edges, r.methods.edges),
    m('collapsed_triangles', 'Collapsed triangles', r.collapsed_triangles, r.methods.edges),
    m('zero_area_triangles', 'Zero-area triangles', r.zero_area_triangles, r.methods.area),
  ];
}

/** The STEP readback (OCP) as metrics. */
export function stepMetrics(m: ReadbackMeasured, action: VoxAction, of?: 'a' | 'b'): VoxMetric[] {
  const engine = m.engine as { ocp?: unknown; cadquery?: unknown } | undefined;
  const by = `${m.worker.name} ${m.worker.version} (OCP ${typeof engine?.ocp === 'string' ? engine.ocp : 'version not reported'})`;
  const base = { tier: TIER.computed, label: LABEL.step, measured_by: by, ...ofPart(of) };
  const bounds = m.bounds.method ?? 'OpenCascade BRepBndLib';
  const unit = `mm${m.unit_in_effect ? '' : ' (the unit in effect was not reported)'}`;
  const facts: VoxMetric[] = [
    { name: 'valid', title: 'Valid shape', value: m.valid, method: 'OpenCascade BRepCheck_Analyzer.IsValid', ...base },
    { name: 'solids', title: 'Solids', value: m.solids, method: 'TopExp_Explorer over TopAbs_SOLID', ...base },
    { name: 'bbox_size', title: 'Bounding box size', value: m.bounds.size, unit, method: bounds, ...base },
  ];
  if (action === 'inspect') return facts;
  return [
    ...facts,
    { name: 'bbox_min', title: 'Bounding box min', value: m.bounds.min, unit, method: bounds, ...base },
    { name: 'bbox_max', title: 'Bounding box max', value: m.bounds.max, unit, method: bounds, ...base },
    { name: 'volume', title: 'Volume', value: m.volume_mm3, unit: 'mm³', method: m.volume_method ?? 'OpenCascade BRepGProp.VolumeProperties', ...base },
  ];
}

/** The .blend readback (a second pass by Blender) as metrics. */
export function blendMetrics(b: BlendReadback, action: VoxAction): VoxMetric[] {
  const by = `${b.worker.name} ${b.worker.version} (Blender ${b.blender_version ?? 'version not reported'})`;
  const base = { tier: TIER.native, label: LABEL.blend, measured_by: by };
  const r = b.read;
  const facts: VoxMetric[] = [
    { name: 'scene', title: 'Active scene', value: r.scene, method: 'bpy.context.scene', ...base },
    { name: 'objects_total', title: 'Objects in the scene', value: r.objects_total, method: 'len(scene.objects)', ...base },
    { name: 'materials', title: 'Materials in the file', value: r.materials.length, method: 'bpy.data.materials', ...base },
    { name: 'cameras', title: 'Cameras', value: r.cameras.map((c) => c.name), method: 'scene objects of type CAMERA', ...base },
    { name: 'active_camera', title: 'Active camera', value: r.active_camera, method: 'scene.camera', ...base },
    { name: 'frame_range', title: 'Frame range', value: r.frame_range, method: 'scene.frame_start, scene.frame_end', ...base },
    { name: 'render_resolution', title: 'Render resolution', value: r.render_resolution, unit: 'px', method: 'scene.render.resolution_x, resolution_y', ...base },
    { name: 'units', title: 'Unit settings', value: r.units, method: 'scene.unit_settings, reported and never applied', ...base },
  ];
  if (action === 'inspect') return facts;
  const sizes = (r.bounds?.objects ?? []).slice(0, 40).map((o): VoxMetric => ({
    name: `size:${o.name}`, title: `Size of ${o.name} (${o.type})`, value: o.size, unit: 'Blender units',
    method: r.bounds?.method ?? 'world-space axis-aligned bounding box', ...base,
  }));
  return [...facts.slice(1, 3), ...sizes];
}

/** The video readback's probe (ffprobe) as metrics. */
export function videoMetrics(v: VideoReadback, of?: 'a' | 'b'): VoxMetric[] {
  const by = `${v.worker.name} ${v.worker.version} (${v.tools.ffprobe?.version ?? 'ffprobe, version not reported'})`;
  const declared = { tier: TIER.declared, label: LABEL.video, measured_by: by, ...ofPart(of) };
  const p = v.probe;
  const probe = 'ffprobe -show_entries (the first video stream and the container)';
  return [
    { name: 'codec', title: 'Codec', value: p.codec, method: probe, ...declared },
    { name: 'pix_fmt', title: 'Pixel format', value: p.pix_fmt, method: probe, ...declared },
    { name: 'width', title: 'Width', value: p.width, unit: 'px', method: probe, ...declared },
    { name: 'height', title: 'Height', value: p.height, unit: 'px', method: probe, ...declared },
    { name: 'fps', title: 'Frame rate', value: p.fps_value, unit: 'frames/s', method: `${probe}: r_frame_rate ${p.fps[0]}/${p.fps[1]}`, ...declared },
    { name: 'duration', title: 'Duration', value: p.duration, unit: 's', method: `${probe}: from ${p.duration_from ?? 'nowhere'}`, ...declared },
    {
      name: 'frames', title: 'Frames', value: p.frames, method: `${probe}: ${p.frames_from ?? 'not given'}`,
      ...declared, ...(p.frames_from?.startsWith('packets') ? { tier: TIER.computed } : {}),
    },
  ];
}

/** The colour samples the video readback measured, one metric per time asked. */
export function videoSampleMetrics(v: VideoReadback, of?: 'a' | 'b'): VoxMetric[] {
  const by = `${v.worker.name} ${v.worker.version} (${v.tools.ffmpeg?.version ?? 'ffmpeg, version not reported'})`;
  const method = `frames decoded by ffmpeg, scaled by 1/${v.scale} (area averaging); pixels within ${v.colour_tolerance} of the colour (${v.colour_metric}); centroid in the video's pixels and as a fraction of the frame`;
  return v.samples.map((s): VoxMetric => ({
    name: `color_at:${s.time}`, title: `Colour region at ${s.time} s (frame ${s.frame})`,
    value: s.why ? null : {
      rgb: s.colour_rgb8, found: s.found ?? false, pixels_scaled: s.pixels ?? 0, centroid_px: s.centroid_video ?? null, centroid_fraction: s.centroid_comp ?? null, box_px: s.box_video ?? null,
    },
    unit: 'video pixels (x right, y down); fraction of the frame', method, tier: TIER.computed, label: LABEL.video, measured_by: by, ...ofPart(of),
    ...(s.why ? { note: `not measured: ${s.why}` } : {}),
  }));
}

/** The geo lane's score as metrics (metric only when nothing was fitted). */
export function geoMetrics(result: Record<string, unknown>, status: string): VoxMetric[] {
  const vox = (result.voxel ?? {}) as Record<string, unknown>;
  const surf = (result.surface ?? {}) as Record<string, unknown>;
  const fs = (surf.fscore ?? {}) as Record<string, unknown>;
  const metric = result.metric === true;
  const unit = typeof result.unit === 'string' ? result.unit : 'm';
  const base = { tier: TIER.computed, label: LABEL.geo, measured_by: 'lanes/geo/voxel_score.py (geo.voxel-score)', note: metric ? 'metric: nothing was fitted' : `not metric: ${status}` };
  const voxel = `occupied voxels of truth (a) and prediction (b) on one grid anchored to the truth; edge ${String(vox.voxel_m ?? '?')} ${unit}, sub-voxel tolerance ${String(vox.tolerance_m ?? '?')} ${unit}`;
  const out: VoxMetric[] = [
    { name: 'voxel_f1', title: 'Voxel F1', value: vox.f1 ?? null, method: voxel, ...base },
    { name: 'voxel_precision', title: 'Voxel precision', value: vox.precision ?? null, method: voxel, ...base },
    { name: 'voxel_recall', title: 'Voxel recall', value: vox.recall ?? null, method: voxel, ...base },
    { name: 'voxel_iou', title: 'Voxel IoU', value: vox.iou ?? null, method: voxel, ...base },
    { name: 'voxel_f1_band', title: 'Voxel F1 over grid phases', value: vox.f1_band ?? null, method: `${voxel}; min and max over ${String(vox.phases ?? '?')} grid phases`, ...base },
    { name: 'fscore', title: `F-score at τ ${String(fs.tau ?? '?')} ${unit}`, value: fs.f ?? null, method: 'Tatarchenko et al. 2019: predicted points within τ of the truth, and truth points within τ of the prediction', ...base },
    { name: 'chamfer_mean_dist', title: 'Chamfer distance (mean)', value: surf.chamfer_mean_dist ?? null, unit, method: 'mean nearest-neighbour distance both ways, averaged', ...base },
    { name: 'points', title: 'Points compared', value: result.points ?? null, method: 'the points each file gave (PLY vertices, or mesh samples)', ...base },
  ];
  return out;
}

/** The spatial module's facts of a Gaussian-splat PLY as metrics. */
export function splatMetrics(facts: Array<{ key: string; value: unknown; epistemic: string; source: { method: string } }>): VoxMetric[] {
  const by = 'src/vision/spatial/gaussian-ply-context.ts (timmy.spatial-model-context/1)';
  return facts.filter((f) => f.epistemic === 'computed' || f.key === 'sampleFields').map((f): VoxMetric => ({
    name: f.key, title: f.key === 'vertexCount' ? 'Gaussians (vertex rows)' : f.key === 'centerBounds' ? 'Centre bounds (not Gaussian support)' : f.key,
    value: f.value, ...(f.key === 'centerBounds' ? { unit: 'scene units (the file\'s raw coordinates)' } : {}), method: f.source.method,
    tier: f.epistemic === 'computed' ? TIER.computed : TIER.declared, label: LABEL.spatial, measured_by: by,
  }));
}

/** A PLY's header as Timmy reads it (declared by the file, not measured): its format, elements and properties. */
export function plyHeaderMetrics(text: string): VoxMetric[] | { error: string } {
  const end = /(?:^|\n)end_header\r?\n/.exec(text);
  if (!text.startsWith('ply') || !end) return { error: 'no PLY header (ply … end_header) in the first 64 KB' };
  const lines = text.slice(0, end.index).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const format = lines.find((l) => l.startsWith('format '))?.slice(7) ?? null;
  const elements = lines.filter((l) => l.startsWith('element ')).map((l) => { const [, name, count] = l.split(/\s+/); return { name, count: Number(count) }; });
  const properties = lines.filter((l) => l.startsWith('property ')).map((l) => l.split(/\s+/).slice(1).join(' '));
  const base = { tier: TIER.declared, label: "the file's PLY header, read by Timmy", measured_by: 'Timmy (src/vox/tools.ts plyHeaderMetrics)', method: 'the header lines before end_header, as written' };
  return [
    { name: 'ply_format', title: 'PLY format', value: format, ...base },
    { name: 'ply_elements', title: 'Elements (as declared)', value: elements, ...base },
    { name: 'ply_properties', title: 'Properties (as declared)', value: properties.slice(0, 64), ...base },
  ];
}

/** b − a (and b / a where asked) for metrics both inputs have, by name; never for values that are not numbers. */
export function deltaMetrics(a: VoxMetric[], b: VoxMetric[], names: string[], ratios: string[] = []): VoxMetric[] {
  const out: VoxMetric[] = [];
  for (const name of names) {
    const x = a.find((m) => m.name === name);
    const y = b.find((m) => m.name === name);
    if (!x || !y) continue;
    const d = delta(x.value, y.value);
    if (d === null) continue;
    const same = x.measured_by === y.measured_by ? x.measured_by : `${x.measured_by}; ${y.measured_by}`;
    out.push({ name: `${name}_delta`, title: `${x.title} (b − a)`, value: d, ...(x.unit ? { unit: x.unit } : {}), method: 'b − a of the two measured values, in double precision', tier: x.tier, label: x.label, measured_by: same, of: 'delta' });
    if (ratios.includes(name)) {
      const r = ratio(x.value, y.value);
      if (r !== null) out.push({ name: `${name}_ratio`, title: `${x.title} (b / a)`, value: r, method: 'b / a of the two measured values, in double precision', tier: x.tier, label: x.label, measured_by: same, of: 'delta' });
    }
  }
  return out;
}

/** Roboflow's predictions as claims (a model's, never metrics, never drawn). */
export function roboflowClaims(out: Record<string, unknown>, model: string): VoxClaim[] {
  const preds = Array.isArray(out.predictions) ? out.predictions.slice(0, 20) : [];
  return [{
    name: 'roboflow_predictions', title: `Roboflow model ${model}: predictions`, value: preds, tier: TIER.model, label: LABEL.roboflow,
    claimed_by: `Roboflow hosted model ${model}`, note: 'A model\'s prediction about the image: a claim, not a measurement, and not drawn as a highlight.',
  }];
}

/** What /measure's [what] may name for a kind (image words; the other kinds measure everything). */
export function measureWords(kind: VoxKind): string[] { return kind === 'image' ? Object.keys(IMAGE_SELECT) : []; }

const isNums = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const o_ = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const triple = (v: unknown): string => (isNums(v) ? v.map(num).join(', ') : '?');

/**
 * A metric's value in words, the same in the terminal and on the board: numbers to seven significant digits, a size as
 * x × y × z, a point as x, y, z, and the structured values (codes, colour regions, differences, samples) in a sentence.
 */
export function metricText(m: { name: string; value: unknown; unit?: string }): string {
  const v = m.value;
  const u = m.unit ? ` ${m.unit}` : '';
  if (v === null || v === undefined) return 'not measured';
  if (typeof v === 'number') return `${num(v)}${u}`;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  if (isNums(v)) return `${v.map(num).join(/size/.test(m.name) && v.length === 3 ? ' × ' : ', ')}${u}`;
  const o = o_(v);
  switch (m.name.split(':')[0]) {
    case 'mean_color': return typeof o?.hex === 'string' ? o.hex : JSON.stringify(v);
    case 'dominant_colors': return Array.isArray(v) ? v.map((c) => `${String(o_(c)?.hex ?? '?')} ${typeof o_(c)?.share === 'number' ? `${num((o_(c)!.share as number) * 100)}%` : ''}`.trim()).join(', ') || 'none' : JSON.stringify(v);
    case 'qr_codes_decoded': return Array.isArray(v) ? (v.length ? v.map((c) => JSON.stringify(String(o_(c)?.text ?? '?'))).join(', ') : 'none decoded (a small, blurred or steep code can be missed)') : JSON.stringify(v);
    case 'aruco_markers': return Array.isArray(v) ? (v.length ? `ids ${v.map((c) => String(o_(c)?.id ?? '?')).join(', ')}` : 'none found (DICT_4X4_50 only)') : JSON.stringify(v);
    case 'color_region': return o ? (typeof o.pixels === 'number' && o.pixels ? `${o.pixels} px (${num(Number(o.share))} of the image) · centroid ${triple(o.centroid)} · box ${triple(o.box)}` : `no pixel within ${String(o.tolerance ?? '?')} of rgb(${triple(o.rgb)})`) : JSON.stringify(v);
    case 'pixel_difference': return o ? `${String(o.changed)} of ${String(o.pixels)} px differ (${num(Number(o.changed_share))}); by more than 16 levels: ${String(o.changed_over_16)} (${num(Number(o.changed_over_16_share))}); max ${String(o.max)}, mean ${num(Number(o.mean))}` : JSON.stringify(v);
    case 'color_at': return o ? (o.found ? `centroid ${triple(o.centroid_px)} px (${triple(o.centroid_fraction)} of the frame) · box ${triple(o.box_px)}` : 'not found at that time') : JSON.stringify(v);
    case 'points': return o ? Object.entries(o).map(([k, x]) => `${k} ${String(x)}`).join(', ') : JSON.stringify(v);
    case 'ply_elements': return Array.isArray(v) ? v.map((e) => `${String(o_(e)?.name ?? '?')} ${String(o_(e)?.count ?? '?')}`).join(', ') : JSON.stringify(v);
    case 'centerBounds': return o ? `min (${triple(o.min)}) · max (${triple(o.max)})${u}` : JSON.stringify(v);
    default: break;
  }
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.length ? v.join(', ') : 'none';
  if (Array.isArray(v) && !v.length) return 'none';
  const s = JSON.stringify(v);
  return s.length > 240 ? `${s.slice(0, 239)}…` : s;
}

/** A short summary of a value for a line in the terminal. */
export function valueWords(v: unknown, unit?: string, name = ''): string {
  const t = metricText({ name, value: v, ...(unit ? { unit } : {}) });
  return t.length > 110 ? `${t.slice(0, 109)}…` : t;
}
