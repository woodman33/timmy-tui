import { describe, expect, it, vi } from 'vitest';
import { getVisionCatalog, type VisionCatalogOptions } from '../src/vision/platform.js';

const env = { ROBOFLOW_WORKSPACE: 'timmy-test', ROBOFLOW_API_KEY: 'rf_catalog_test_secret' };
const completeSpec = {
  version: '1.0', inputs: [{ type: 'InferenceImage', name: 'photo' }, { type: 'InferenceParameter', name: 'threshold' }],
  steps: [{ type: 'roboflow_core/roboflow_object_detection_model@v1', name: 'detect', model_id: 'yolo26n-640' }],
  outputs: [{ type: 'JsonField', name: 'predictions', selector: '$steps.detect.predictions' }],
};
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn<NonNullable<VisionCatalogOptions['fetch']>>(async input => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    return route ? route() : json({ error: 'missing fixture' }, 404);
  });
}
function fixture(extraRoutes: Record<string, () => Response> = {}, list = [{ id: 'workflow-123', url: 'inspection', name: 'Inspection' }]) {
  return fakeFetch({
    '/timmy-test': () => json({ workspace: { name: 'Timmy', projects: [{ id: 'timmy-test/cards', name: 'Cards', type: 'object-detection', images: 25, versions: 2, api_key: 'never-returned', owner: { email: 'private' } }] } }),
    '/timmy-test/workflows': () => json({ workflows: list }),
    '/timmy-test/workflows/inspection': () => json({ workflow: { config: JSON.stringify({ specification: completeSpec, secrets: { key: 'never-returned' } }) } }),
    ...extraRoutes,
  });
}

describe('Roboflow workspace discovery', () => {
  it('returns a compact catalogue from authenticated GETs without executing or changing anything', async () => {
    const fetch = fixture();
    const result = await getVisionCatalog({ env, fetch });
    expect(result).toMatchObject({ ok: true, state: 'connected', workspace: { id: 'timmy-test', name: 'Timmy' } });
    expect(result.projects).toEqual([{ id: 'timmy-test/cards', name: 'Cards', type: 'object-detection', images: 25, versions: 2 }]);
    expect(result.workflows).toEqual([{
      id: 'workflow-123', workflowId: 'inspection', name: 'Inspection', inputNames: ['photo', 'threshold'], imageInputNames: ['photo'],
      outputNames: ['predictions'], stepCount: 1, blockTypes: ['roboflow_core/roboflow_object_detection_model@v1'],
      modelIds: ['yolo26n-640'], hasUploadSink: false, readyDefinition: true, definitionState: 'ready',
    }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetch.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.roboflow\.com\/timmy-test/);
      expect(String(url)).not.toContain(env.ROBOFLOW_API_KEY);
      expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${env.ROBOFLOW_API_KEY}` } });
      expect(options).not.toHaveProperty('body');
    }
    expect(result.note).toContain('structure only');
    expect(JSON.stringify(result)).not.toMatch(/never-returned|private|rf_catalog_test_secret/);
    expect(result.workflows[0]).not.toHaveProperty('specification');
  });

  it('does no network work until both the API key and a valid workspace are configured', async () => {
    const fetch = fixture();
    for (const partialEnv of [{}, { ROBOFLOW_API_KEY: env.ROBOFLOW_API_KEY }, { ...env, ROBOFLOW_WORKSPACE: 'https://evil.test' },
      { ...env, ROBOFLOW_WORKSPACE: '../another-workspace' }, { ...env, ROBOFLOW_WORKSPACE: 'timmy?api_key=evil' }]) {
      expect(await getVisionCatalog({ env: partialEnv, fetch })).toMatchObject({ ok: false, state: 'not_configured' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('distinguishes saved drafts, unreadable definitions, and upload blocks', async () => {
    const list = ['draft', 'upload', 'bad-json'].map(url => ({ id: url, url, name: url }));
    const fetch = fixture({
      '/timmy-test/workflows/draft': () => json({ workflow: { config: JSON.stringify({ specification: { version: '1.0', inputs: [], steps: [], outputs: [] } }) } }),
      '/timmy-test/workflows/upload': () => json({ workflow: { config: { specification: { ...completeSpec, steps: [...completeSpec.steps,
        { type: 'roboflow_core/roboflow_dataset_upload@v2', name: 'upload', api_key: 'secret-in-definition' }] } } } }),
      '/timmy-test/workflows/bad-json': () => json({ workflow: { config: 'bad json secret-in-definition' } }),
    }, list);
    const result = await getVisionCatalog({ env, fetch });
    expect(result.workflows.map(workflow => [workflow.workflowId, workflow.readyDefinition, workflow.definitionState, workflow.hasUploadSink])).toEqual([
      ['draft', false, 'draft', false], ['upload', true, 'ready', true], ['bad-json', false, 'invalid', false],
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-in-definition');
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('accepts bare saved specifications while excluding model parameter references', async () => {
    const fetch = fixture({ '/timmy-test/workflows/inspection': () => json({ workflow: {
      config: JSON.stringify({ ...completeSpec, steps: [{ name: 'detect', type: 'custom/model@v1', model_id: '$inputs.model', modelId: 'cards/2' }] }),
    } }) });
    const result = await getVisionCatalog({ env, fetch });
    expect(result.workflows[0]).toMatchObject({ readyDefinition: true, modelIds: ['cards/2'] });
  });

  it('keeps available projects when Workflow access is denied', async () => {
    const fetch = fixture({ '/timmy-test/workflows': () => json({ error: `Bearer ${env.ROBOFLOW_API_KEY}` }, 403) });
    const result = await getVisionCatalog({ env, fetch });
    expect(result).toMatchObject({ ok: true, state: 'partial', workflows: [] });
    expect(result.projects).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(env.ROBOFLOW_API_KEY);
  });

  it('keeps available Workflow metadata when one definition is denied', async () => {
    const fetch = fixture({ '/timmy-test/workflows/inspection': () => json({ error: 'private details' }, 403) });
    const result = await getVisionCatalog({ env, fetch });
    expect(result).toMatchObject({ ok: true, state: 'partial', workflows: [{ workflowId: 'inspection', readyDefinition: false, definitionState: 'unavailable' }] });
    expect(JSON.stringify(result)).not.toContain('private details');
  });

  it('can list workflows when project access is denied without pretending the workspace name was fetched', async () => {
    const fetch = fixture({ '/timmy-test': () => json({}, 403) });
    const result = await getVisionCatalog({ env, fetch });
    expect(result).toMatchObject({ ok: true, state: 'partial', workspace: { id: 'timmy-test', name: 'timmy-test' }, projects: [] });
    expect(result.workflows).toHaveLength(1);
  });

  it('returns safe authentication errors without raw upstream bodies', async () => {
    const fetch = fakeFetch({ '/timmy-test': () => json({ error: env.ROBOFLOW_API_KEY }, 401), '/timmy-test/workflows': () => json({ error: 'private detail' }, 403) });
    const result = await getVisionCatalog({ env, fetch });
    expect(result).toMatchObject({ ok: false, state: 'unauthorized', workspace: null });
    expect(JSON.stringify(result)).not.toMatch(/private detail|rf_catalog_test_secret/);
  });

  it('redacts credentials if upstream reflects them in allowlisted fields', async () => {
    const fetch = fixture({
      '/timmy-test': () => json({ workspace: { name: env.ROBOFLOW_API_KEY, projects: [{ id: 'p1', name: 'client_secret=unknown-secret' }] } }),
      '/timmy-test/workflows/inspection': () => json({ workflow: { config: { specification: { ...completeSpec,
        steps: [{ name: 'model', type: 'custom/model@v1', model_id: env.ROBOFLOW_API_KEY }],
        inputs: [{ type: 'InferenceImage', name: 'api_key=unknown-secret' }],
      } } } }),
    });
    const result = await getVisionCatalog({ env, fetch });
    expect(JSON.stringify(result)).not.toMatch(/unknown-secret|rf_catalog_test_secret/);
    expect(result.workspace?.name).toBe('[redacted]');
  });

  it('refuses upstream Workflow URL traversal and public URLs before fetching details', async () => {
    const fetch = fixture({}, [{ id: 'a', url: '../other', name: 'bad' }, { id: 'b', url: 'https://evil.test', name: 'bad' }]);
    const result = await getVisionCatalog({ env, fetch });
    expect(result).toMatchObject({ ok: true, state: 'partial', workflows: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not fall back to lastVersionConfig when the current config is an empty draft', async () => {
    const fetch = fixture({ '/timmy-test/workflows/inspection': () => json({ workflow: { config: '{}', lastVersionConfig: { specification: completeSpec } } }) });
    const result = await getVisionCatalog({ env, fetch });
    expect(result.workflows[0]).toMatchObject({ stepCount: 0, readyDefinition: false, definitionState: 'draft' });
  });

  it('handles transport failures and invalid JSON without leaking request details', async () => {
    const fetch = vi.fn<NonNullable<VisionCatalogOptions['fetch']>>(async () => { throw new Error(`private transport ${env.ROBOFLOW_API_KEY}`); });
    const result = await getVisionCatalog({ env, fetch });
    expect(result).toMatchObject({ ok: false, state: 'unavailable' });
    expect(JSON.stringify(result)).not.toMatch(/private transport|rf_catalog_test_secret/);
    const malformed = vi.fn<NonNullable<VisionCatalogOptions['fetch']>>(async () => new Response('{malformed'));
    expect(await getVisionCatalog({ env, fetch: malformed })).toMatchObject({ ok: false, state: 'unavailable' });
  });
});
