import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { integrationCatalogEntry } from './integrations/registry.js';
import { getVisionStatus } from './runtime.js';

export type WorkspaceToolState = 'not_configured' | 'configured_unchecked' | 'available_unchecked' | 'not_installed';
export interface WorkspaceToolStatus {
  id: string;
  name: string;
  state: WorkspaceToolState;
  desc: string;
  command: string;
  checkedAt: string;
  note: string;
  reasons?: string[];
  runCommand?: string;
  requestExample?: object;
}

export const workspaceToolIds = ['roboflow', 'rerun', 'viser', 'fiftyone', 'tldraw'] as const;
export type WorkspaceToolId = typeof workspaceToolIds[number];
export interface WorkspaceProbeResult { state: WorkspaceToolState; reasons?: string[] }
export interface StatusDependencies {
  getStatus?: (dir: string) => Promise<{ state: string; reasons?: unknown }>;
  catalog?: (dir: string) => { id: string; installedAdapter: boolean; configurationError?: unknown }[];
  pathExists?: (path: string) => boolean;
  now?: () => Date;
  probes?: Partial<Record<WorkspaceToolId, (dir: string) => unknown | Promise<unknown>>>;
  probeTimeoutMs?: number;
}

// Public guidance is fixed text. Neither dependency results nor configuration
// values may become browser-visible paths, endpoints or credentials.
function publicReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 12).map(reason => {
    if (reason === 'TIMMY_VISUAL_PYTHON must be an absolute interpreter path.' || reason === 'TIMMY_TELEMETRY_PYTHON must be an absolute interpreter path.') return reason;
    if (reason === 'The local status probe timed out.' || reason === 'The local status probe returned invalid output.') return reason;
    if (reason === 'TIMMY_VISION_RUNTIME must be http or library.') return 'Choose the HTTP or library runtime.';
    if (reason === 'inference-sdk Python package is missing.') return 'The inference-sdk package is missing.';
    if (reason === 'inference Python package is missing.') return 'The inference package is missing.';
    if (reason === 'TIMMY_VISION_SERVER_URL must be an HTTP(S) address without credentials or query parameters.') return 'The inference server address needs correction.';
    if (reason === 'Choose a model or a workspace and Workflow before running.') return 'Choose a model or workspace Workflow.';
    if (reason === 'ROBOFLOW_API_KEY is missing.') return 'Add the API key to the private server configuration.';
    return 'The local vision runtime needs attention; inspect its configuration status.';
  }))];
}

class ProbeFailure extends Error {}
function checkedProbe(value: unknown): WorkspaceProbeResult {
  if (!value || typeof value !== 'object') throw new ProbeFailure('The local status probe returned invalid output.');
  const result = value as WorkspaceProbeResult;
  if (!['not_configured', 'configured_unchecked', 'available_unchecked', 'not_installed'].includes(result.state)
    || (result.reasons !== undefined && (!Array.isArray(result.reasons) || !result.reasons.every(reason => typeof reason === 'string')))) {
    throw new ProbeFailure('The local status probe returned invalid output.');
  }
  return { state: result.state, ...(result.reasons === undefined ? {} : { reasons: publicReasons(result.reasons) }) };
}

async function independentProbe(probe: () => unknown | Promise<unknown>, timeoutMs: number): Promise<WorkspaceProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      Promise.resolve().then(probe),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProbeFailure('The local status probe timed out.')), timeoutMs); }),
    ]);
    return checkedProbe(output);
  } catch (error) {
    return {
      state: 'not_configured',
      reasons: publicReasons([error instanceof Error ? error.message : undefined]),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Read-only readiness. No model, native scene, viewer or cloud request is run. */
export async function visionWorkspaceStatus(dir = process.cwd(), deps: StatusDependencies = {}) {
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  const getStatus = deps.getStatus ?? (root => getVisionStatus({ dir: root }));
  const pathExists = deps.pathExists ?? existsSync;
  const cli = 'node --import tsx src/cli.ts vision';
  const adapter = (id: 'viser' | 'fiftyone') => {
    const catalog = deps.catalog ? deps.catalog(dir) : [integrationCatalogEntry(id, dir)];
    if (!Array.isArray(catalog)) {
      throw new ProbeFailure('The local status probe returned invalid output.');
    }
    const entry = catalog.find(tool => tool && tool.id === id);
    if (entry && typeof entry.installedAdapter !== 'boolean') throw new ProbeFailure('The local status probe returned invalid output.');
    if (entry?.configurationError !== undefined) {
      if (typeof entry.configurationError !== 'string') throw new ProbeFailure('The local status probe returned invalid output.');
      return { state: 'not_configured', reasons: [entry.configurationError] };
    }
    return { state: entry?.installedAdapter === true ? 'available_unchecked' : 'not_installed' };
  };
  const defaults: Record<WorkspaceToolId, () => unknown | Promise<unknown>> = {
    roboflow: async () => {
      const vision = await getStatus(dir);
      if (!vision || typeof vision.state !== 'string'
        || (vision.reasons !== undefined && (!Array.isArray(vision.reasons) || !vision.reasons.every(reason => typeof reason === 'string')))) {
        throw new ProbeFailure('The local status probe returned invalid output.');
      }
      return { state: vision.state === 'configured_unchecked' ? 'configured_unchecked' : 'not_configured', reasons: vision.reasons };
    },
    rerun: () => {
      const present = pathExists(join(dir, 'studio/spatial-intelligence-20260909/.venv/bin/python'));
      if (typeof present !== 'boolean') throw new ProbeFailure('The local status probe returned invalid output.');
      return { state: present ? 'available_unchecked' : 'not_configured' };
    },
    viser: () => adapter('viser'),
    fiftyone: () => adapter('fiftyone'),
    tldraw: () => ({ state: 'available_unchecked' }),
  };
  const timeoutMs = typeof deps.probeTimeoutMs === 'number' && Number.isFinite(deps.probeTimeoutMs) && deps.probeTimeoutMs > 0
    ? Math.min(deps.probeTimeoutMs, 10_000) : 1_000;
  const settled = await Promise.allSettled(workspaceToolIds.map(id => independentProbe(
    () => deps.probes?.[id] ? deps.probes[id]!(dir) : defaults[id](), timeoutMs,
  )));
  const observations = Object.fromEntries(workspaceToolIds.map((id, index) => {
    const result = settled[index];
    return [id, result.status === 'fulfilled' ? result.value : { state: 'not_configured', reasons: publicReasons([]) }];
  })) as Record<WorkspaceToolId, WorkspaceProbeResult>;
  const tools: WorkspaceToolStatus[] = [
    {
      id: 'roboflow', name: 'Roboflow', state: observations.roboflow.state,
      desc: 'Inspect images and Workflows, then review archived observations.', command: `${cli} status`, checkedAt,
      note: 'Local configuration and dependency probe only. Connection and inference remain unchecked.',
      reasons: observations.roboflow.reasons ?? [],
      runCommand: `${cli} run --image IMAGE.png --model MODEL_ID`,
      requestExample: { instruction: 'Replace IMAGE.png and MODEL_ID with your chosen inputs. Execution can send the image to the configured server and incur provider cost.' },
    },
    {
      id: 'rerun', name: 'Rerun',
      state: observations.rerun.state,
      ...(observations.rerun.reasons ? { reasons: observations.rerun.reasons } : {}),
      desc: 'Replay recorded observations over source time.', command: 'rerun RECORDING.rrd', checkedAt,
      note: 'Viewer command only. The recorder environment is not established by PATH viewer presence. Pinned recorder SDK version and recording behavior have not been checked. Timmy has no recording CLI here; configure the pinned Python SDK separately.',
    },
    {
      id: 'viser', name: 'Viser', state: observations.viser.state,
      ...(observations.viser.reasons ? { reasons: observations.viser.reasons } : {}),
      desc: 'Inspect and control a 3D scene through the registered local adapter.', command: `${cli} integrations list`, checkedAt,
      note: 'Filesystem presence only; Python imports, scene controls and native execution are unchecked.',
      runCommand: `${cli} integrations run viser --request viser-request.json`,
      requestExample: { operation: 'scene', input_mesh: '/absolute/scene.glb', translation_x: 3, keep_alive_seconds: 60 },
    },
    {
      id: 'fiftyone', name: 'FiftyOne', state: observations.fiftyone.state,
      ...(observations.fiftyone.reasons ? { reasons: observations.fiftyone.reasons } : {}),
      desc: 'Curate local images and inspect duplicates using the registered adapter.', command: `${cli} integrations list`, checkedAt,
      note: 'Filesystem presence only; Python imports and dataset operations are unchecked. The adapter contract uses pixel descriptors, not semantic embeddings.',
      runCommand: `${cli} integrations run fiftyone --request fiftyone-request.json`,
      requestExample: { operation: 'curate', input_images: ['/absolute/a.png', '/absolute/b.png', '/absolute/c.png', '/absolute/d.png'] },
    },
    {
      id: 'tldraw', name: 'tldraw Canvas', state: observations.tldraw.state,
      ...(observations.tldraw.reasons ? { reasons: observations.tldraw.reasons } : {}),
      desc: 'Plan the workflow on a blank canvas and keep editable state.', command: `${cli} serve`, checkedAt,
      note: 'Canvas route is provided locally. Browser loading and external CDN dependencies have not been checked by this status probe.',
    },
  ];
  return { tools, checkedAt, note: 'Readiness is separate from successful execution. No model, scene, viewer or cloud request was run.' };
}
