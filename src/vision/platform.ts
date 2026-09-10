import { redactVisionValue } from './runtime.js';

export interface VisionCatalogOptions {
  /** Configuration is loaded by the caller; this operation does not mutate process.env. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}
export interface VisionProjectSummary {
  id: string; name: string; type: string | null; images: number | null; versions: number | null;
}
export interface VisionWorkflowSummary {
  id: string; workflowId: string; name: string;
  inputNames: string[]; imageInputNames: string[]; outputNames: string[];
  stepCount: number; blockTypes: string[]; modelIds: string[];
  hasUploadSink: boolean; readyDefinition: boolean;
  definitionState: 'ready' | 'draft' | 'invalid' | 'unavailable';
}
export interface VisionCatalog {
  ok: boolean;
  state: 'connected' | 'partial' | 'not_configured' | 'unauthorized' | 'unavailable';
  workspace: { id: string; name: string } | null;
  projects: VisionProjectSummary[];
  workflows: VisionWorkflowSummary[];
  note: string;
}

const ORIGIN = 'https://api.roboflow.com';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_WORKFLOWS = 100;
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}
function label(value: unknown): string { return typeof value === 'string' ? value.trim().slice(0, 240) : ''; }
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function rows(value: unknown): RecordValue[] { return Array.isArray(value) ? value.map(record).filter((v): v is RecordValue => !!v) : []; }

/** Accept the saved Platform config envelope as well as a bare Workflow specification. */
function specification(detail: unknown): RecordValue | undefined {
  const body = record(detail);
  const workflow = record(body?.workflow) ?? body;
  let candidate = workflow?.config ?? workflow?.specification;
  if (typeof candidate === 'string') {
    if (candidate.length > MAX_RESPONSE_BYTES) return undefined;
    try { candidate = JSON.parse(candidate.replace(/^\uFEFF/, '')); } catch { return undefined; }
  }
  const config = record(candidate);
  return record(config?.specification) ?? config;
}

function summarizeWorkflow(row: RecordValue, workflowId: string, detail?: unknown): VisionWorkflowSummary {
  const summary: VisionWorkflowSummary = {
    id: label(row.id) || workflowId, workflowId, name: label(row.name) || workflowId,
    inputNames: [], imageInputNames: [], outputNames: [], stepCount: 0, blockTypes: [], modelIds: [],
    hasUploadSink: false, readyDefinition: false, definitionState: detail === undefined ? 'unavailable' : 'invalid',
  };
  if (detail === undefined) return summary;
  const spec = specification(detail);
  if (!spec) return summary;
  const inputs = rows(spec.inputs), outputs = rows(spec.outputs), steps = rows(spec.steps);
  summary.inputNames = unique(inputs.map(input => label(input.name)));
  summary.imageInputNames = unique(inputs.filter(input => input.type === 'InferenceImage').map(input => label(input.name)));
  summary.outputNames = unique(outputs.map(output => label(output.name)));
  summary.stepCount = steps.length;
  summary.blockTypes = unique(steps.map(step => label(step.type)));
  summary.modelIds = unique(steps.flatMap(step => [label(step.model_id), label(step.modelId)]).filter(id => !id.startsWith('$')));
  // Report known upload blocks and custom blocks explicitly named as uploaders. We never execute them here.
  summary.hasUploadSink = summary.blockTypes.some(type => /(?:upload|uploader)(?:[_/@-]|$)/i.test(type));
  summary.readyDefinition = typeof spec.version === 'string' && steps.length > 0 && outputs.length > 0
    && steps.every(step => !!label(step.type) && !!label(step.name))
    && outputs.every(output => !!label(output.name) && typeof output.selector === 'string');
  summary.definitionState = summary.readyDefinition ? 'ready' : steps.length === 0 || outputs.length === 0 ? 'draft' : 'invalid';
  return summary;
}

type ApiResult = { ok: true; data: unknown } | { ok: false; reason: 'unauthorized' | 'unavailable' };

/**
 * Read-only discovery, invoked explicitly rather than by the routine local status probe.
 * Routes and Bearer API-key auth follow Roboflow's Platform OpenAPI and roboflow.adapters.rfapi.
 * The endpoint is fixed, redirects are refused, and neither raw API errors nor definitions leave this module.
 */
export async function getVisionCatalog(options: VisionCatalogOptions = {}): Promise<VisionCatalog> {
  const env = options.env ?? process.env;
  const workspaceId = env.ROBOFLOW_WORKSPACE?.trim() ?? '';
  const apiKey = env.ROBOFLOW_API_KEY?.trim() ?? '';
  const empty = (state: VisionCatalog['state'], note: string): VisionCatalog => ({
    ok: false, state, workspace: null, projects: [], workflows: [], note,
  });
  if (!apiKey || !workspaceId) return empty('not_configured', 'Add your Roboflow API key and workspace to the private configuration first.');
  if (!SLUG.test(workspaceId)) return empty('not_configured', 'ROBOFLOW_WORKSPACE must be a workspace slug, without a URL or path.');

  const request = options.fetch ?? globalThis.fetch;
  async function get(path: string): Promise<ApiResult> {
    try {
      const response = await request(`${ORIGIN}/${encodeURIComponent(workspaceId)}${path}`, {
        method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, reason: response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable' };
      }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        return { ok: false, reason: 'unavailable' };
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return { ok: false, reason: 'unavailable' };
      return { ok: true, data: JSON.parse(text) };
    } catch { return { ok: false, reason: 'unavailable' }; }
  }

  const [account, workflowList] = await Promise.all([get(''), get('/workflows')]);
  if (!account.ok && !workflowList.ok) return empty(
    account.reason === 'unauthorized' || workflowList.reason === 'unauthorized' ? 'unauthorized' : 'unavailable',
    account.reason === 'unauthorized' || workflowList.reason === 'unauthorized'
      ? 'Roboflow did not authorize workspace discovery. Check the key and workspace permissions.'
      : 'Roboflow could not be reached or returned an unreadable response. Try discovery again later.',
  );
  const workspace = account.ok ? record(record(account.data)?.workspace) : undefined;
  const workflowBody = workflowList.ok ? record(workflowList.data) : undefined;
  const allWorkflows = rows(workflowBody?.workflows);
  let partial = !workspace || !Array.isArray(workspace.projects) || !Array.isArray(workflowBody?.workflows)
    || allWorkflows.length > MAX_WORKFLOWS;
  const projects: VisionProjectSummary[] = rows(workspace?.projects).map(project => ({
    id: label(project.id) || label(project.url), name: label(project.name) || label(project.id),
    type: label(project.type) || null, images: count(project.images), versions: count(project.versions),
  })).filter(project => project.id);
  const candidates = allWorkflows.slice(0, MAX_WORKFLOWS).flatMap(row => {
    const workflowId = label(row.url) || label(row.workflowId) || label(row.id);
    if (!SLUG.test(workflowId)) { partial = true; return []; }
    return [{ row, workflowId }];
  });
  const workflows: VisionWorkflowSummary[] = [];
  // Four definition reads at a time keep larger workspaces from flooding the Platform API.
  for (let index = 0; index < candidates.length; index += 4) {
    const batch = await Promise.all(candidates.slice(index, index + 4).map(async ({ row, workflowId }) => {
      const result = await get(`/workflows/${encodeURIComponent(workflowId)}`);
      if (!result.ok) partial = true;
      return summarizeWorkflow(row, workflowId, result.ok ? result.data : undefined);
    }));
    workflows.push(...batch);
  }
  const result: VisionCatalog = {
    ok: true, state: partial ? 'partial' : 'connected',
    workspace: { id: workspaceId, name: label(workspace?.name) || workspaceId }, projects, workflows,
    note: partial
      ? 'Available workspace items are listed; some items could not be read. Definition readiness checks structure only. No Workflow was run or image uploaded.'
      : 'Workspace discovery complete. Definition readiness checks structure only; no Workflow was run or image uploaded.',
  };
  return redactVisionValue(result, { ...env, ROBOFLOW_API_KEY: apiKey }) as VisionCatalog;
}
