import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Interpreter choice is explicit operator configuration, never inferred from receipt storage. */
export function visualPythonExecutable(dir = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  if (env.TIMMY_VISUAL_PYTHON) {
    if (!isAbsolute(env.TIMMY_VISUAL_PYTHON)) throw new Error('TIMMY_VISUAL_PYTHON must be an absolute interpreter path.');
    return env.TIMMY_VISUAL_PYTHON;
  }
  return resolve(dir, '.timmy/venv-visual/bin/python');
}

export function telemetryPythonExecutable(dir = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  if (env.TIMMY_TELEMETRY_PYTHON) {
    if (!isAbsolute(env.TIMMY_TELEMETRY_PYTHON)) throw new Error('TIMMY_TELEMETRY_PYTHON must be an absolute interpreter path.');
    return env.TIMMY_TELEMETRY_PYTHON;
  }
  return resolve(dir, '.timmy/venv-platform-telemetry/bin/python');
}

/** Native source assets stay at package root for both src and dist/src layouts. */
function packagedAdapter(relativePath: string) {
  const candidates = ['../../../', '../../../../'].map(prefix =>
    fileURLToPath(new URL(`${prefix}${relativePath}`, import.meta.url)));
  return candidates.find(existsSync) ?? candidates[0];
}

const requestContracts: Record<string, object> = {
  'camera-fit': {
    example: { operation: 'probe' },
    input: 'fit: object_id, source_revision (SHA-256), frame_id, units (m/cm/mm/scene-unit), image_size [width,height], camera_matrix (3x3 zero-skew pixels), distortion ([] or five coefficients), correspondences and validation_correspondences (id/world[3]/pixel[2]). 6–64 noncoplanar fitting points; 3–64 separate validation points. Self-contained request, no image/file/network loading.',
    result: 'OpenCV camera-from-world pose and per-point reprojection residuals. Validation points never enter fitting. Reconstructed proposal only; declared source revision/units are not independently authenticated. No native edit, model inference or physical-geometry certification.',
  },
  mcap: { example: { operation: 'export', input: '/absolute/simulation.json' }, input: '1–10000 finite rows: timeSeconds, positionMetres[3], contactCount; optional penetrationMetres. Maximum16MiB.', replay: 'operation=replay; known Timmy simulation schema/topic only, one channel,≤64KiB/row,≤16MiB input and expanded chunks, required data/chunk CRCs. ZSTD known-size or uncompressed. Explicit source required; no implicit private fixture or new simulation.' },
  plotjuggler: { example: { operation: 'open', input: '/absolute/simulation.csv', layout: '/absolute/layout.xml' }, input: 'Local CSV≤16MiB; optional local XML layout. Native viewer launch is not data qualification.', export: 'Same simulation JSON contract as MCAP; produces both MCAP and CSV.' },
  viser: { example: { operation: 'scene', input_mesh: '/absolute/scene.glb', translation_x: 3, keep_alive_seconds: 60 }, input: 'Optional self-contained glTF2 GLB≤64MiB. Without input_mesh uses the preserved house fixture. translation_x0.5–5m; keep_alive_seconds0–300.' },
  fiftyone: { example: { operation: 'curate', input_images: ['/absolute/a.png', '/absolute/b.png', '/absolute/c.png', '/absolute/d.png'] }, input: '4–24 local PNG/JPG images, each≤16MiB and24MP. Mutually exclusive with fixture count4–24. Adds one deliberate duplicate. Pixel descriptors, not semantic embeddings.' },
  paraview: { example: { operation: 'field', input_volume: '/absolute/field.vti', scalar: 'density', level: 0.5 }, input: 'Optional self-contained ASCII VTI≤32MiB, one axis-aligned ImageData Piece,≤250000points/cells,≤256points/axis;1–4 Float32/Float64 point scalars. scalar required with input_volume; level strictly within its range, defaults midpoint. Without input_volume uses analytic fixture with level−8–8m.' },
  trame: { example: { operation: 'field', input_volume: '/absolute/field.vti', scalar: 'density', keep_alive_seconds: 60 }, input: 'Same bounded ASCII VTI contract as ParaView, plus native browser contour control. keep_alive_seconds0–300. No binary/appended/compressed VTI or external resources.' },
  openhands: { example: { operation: 'review', prompt: 'Review this bounded interface proposal…' }, input: 'Prompt≤20000 characters; fixed configured local Qwen via SDK1.46. No shell, browser or arbitrary model access. probe runs declared runtime checks.' },
  cosmos: { example: { operation: 'infer', input_image: '/absolute/render.png', prompt: 'Describe visible colors and spatial relationships.', max_new_tokens: 256 }, input: 'One local PNG/JPEG≤8MiB and2MP; prompt≤2000characters; tokens16–384. Fixed Cosmos3-Edge reasoner on configured GPU. Generator not enabled.' },
};

/** Optional adapters keep large native runtimes out of Timmy's control plane. */
export function integrationDefinitions(dir = process.cwd()) {
  const root = resolve(dir);
  const tool = (name: string) => resolve(root, 'tools/platform-vision-20260910', name, 'adapter.py');
  const telemetry = telemetryPythonExecutable(root);
  const analytics = resolve(root, 'studio/platform-expansion-20260910/analytics/.venv/bin/python');
  return [
    { id: 'camera-fit', name: 'OpenCV camera alignment', executable: visualPythonExecutable(root), script: packagedAdapter('tools/spatial-fit-20260915/adapter.py'), operations: ['probe', 'fit'], executionKind: 'local-geometry-fit' },
    { id: 'mcap', name: 'MCAP recordings', executable: telemetry, script: packagedAdapter('tools/platform-vision-20260910/telemetry/adapter.py'), operations: ['probe', 'export', 'replay'], executionKind: 'local-interchange' },
    { id: 'plotjuggler', name: 'PlotJuggler telemetry', executable: telemetry, script: packagedAdapter('tools/platform-vision-20260910/telemetry/adapter.py'), operations: ['probe', 'export', 'open'], executionKind: 'local-native-viewer' },
    { id: 'viser', name: 'Viser interactive 3D', executable: analytics, script: tool('analytics'), operations: ['probe', 'scene'], executionKind: 'local-3d-viewer' },
    { id: 'fiftyone', name: 'FiftyOne Brain', executable: analytics, script: tool('analytics'), operations: ['probe', 'curate'], executionKind: 'local-dataset-analysis' },
    { id: 'paraview', name: 'ParaView scientific analysis', executable: analytics, script: tool('analytics'), operations: ['probe', 'field'], executionKind: 'local-native-analysis' },
    { id: 'trame', name: 'trame scientific views', executable: analytics, script: tool('analytics'), operations: ['probe', 'field'], executionKind: 'local-web-analysis' },
    { id: 'openhands', name: 'OpenHands · Qwen', executable: resolve(homedir(), '.local/share/timmy/runtimes/openhands-1.46.0/bin/python'), script: tool('openhands'), operations: ['probe', 'review'], executionKind: 'local-agent' },
    { id: 'cosmos', name: 'NVIDIA Cosmos3-Edge Reasoner', executable: telemetry, script: tool('cosmos'), operations: ['probe', 'infer'], executionKind: 'gpu-model' },
  ];
}

/** Installed adapter is a filesystem observation, never an inference/readiness claim. */
export function integrationCatalog(dir = process.cwd()) {
  return integrationDefinitions(dir).map(({ executable, script, ...item }) => ({
    ...item, installedAdapter: existsSync(executable) && existsSync(script),
    requestContract: requestContracts[item.id],
    qualification: 'Run a declared operation and inspect its receipt; presence is not qualification.',
  }));
}
