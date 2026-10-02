import { describe, expect, it, vi } from 'vitest';
import { visionWorkspaceStatus, workspaceToolIds, type StatusDependencies, type WorkspaceToolId } from '../src/vision/workspace-status.js';
import { integrationCatalog, integrationDefinitions, integrationCatalogEntry } from '../src/vision/integrations/registry.js';

describe('vision workspace readiness', () => {
  it('distinguishes absent runtimes from unchecked adapter presence', async () => {
    const getStatus = vi.fn(async () => ({ state: 'configured_unchecked', reasons: [] }));
    const result = await visionWorkspaceStatus('/fixture', {
      getStatus, catalog: () => [{ id: 'viser', installedAdapter: true }, { id: 'fiftyone', installedAdapter: false }],
      pathExists: () => false, now: () => new Date('2026-10-01T12:00:00Z'),
    });
    expect(getStatus).toHaveBeenCalledExactlyOnceWith('/fixture');
    expect(Object.fromEntries(result.tools.map(tool => [tool.id, tool.state]))).toEqual({
      roboflow: 'configured_unchecked', rerun: 'not_configured', viser: 'available_unchecked', fiftyone: 'not_installed', tldraw: 'available_unchecked',
    });
    expect(result.checkedAt).toBe('2026-10-01T12:00:00.000Z');
    expect(result.tools.every(tool => tool.checkedAt === result.checkedAt)).toBe(true);
    expect(result.tools.find(tool => tool.id === 'rerun')?.command).toBe('rerun RECORDING.rrd');
    expect(result.tools.find(tool => tool.id === 'rerun')?.note).toContain('Viewer command only');
  });

  it('never relays dependency paths, endpoints or secrets into public guidance', async () => {
    const result = await visionWorkspaceStatus('/private/project', {
      getStatus: async () => ({ state: 'connected', reasons: ['secret=fixture-value /private/project https://private.example', 'ROBOFLOW_API_KEY is missing.'], serverUrl: 'https://private.example', key: 'fixture-value' }),
      catalog: () => [], pathExists: () => true,
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain('/private/project');
    expect(json).not.toContain('private.example');
    expect(json).not.toContain('fixture-value');
    expect(json).not.toContain('serverUrl');
    expect(result.tools[0].state).toBe('not_configured');
    expect(result.tools[0].reasons).toContain('Add the API key to the private server configuration.');
    expect(result.tools.find(tool => tool.id === 'rerun')?.state).toBe('available_unchecked');
  });

  it('keeps configuration failures structured without echoing thrown details', async () => {
    const result = await visionWorkspaceStatus('/fixture', {
      getStatus: async () => { throw new Error('fixture-secret /private/config'); }, catalog: () => [], pathExists: () => false,
    });
    expect(result.tools[0].state).toBe('not_configured');
    expect(result.tools[0].reasons).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
});

describe('independent workspace probes (development controls)', () => {
  const now = () => new Date('2026-10-01T12:00:00Z');
  const secret = 'relative-secret/?token="fixture%private"';
  const healthy = () => ({ state: 'available_unchecked', reasons: [] });
  const fixtures = (): StatusDependencies => ({
    now, probeTimeoutMs: 25,
    probes: Object.fromEntries(workspaceToolIds.map(id => [id, healthy])),
  });
  const faults = {
    'synchronous throw': () => { throw new Error(secret); },
    rejection: () => Promise.reject(new Error(secret)),
    timeout: () => new Promise(() => {}),
    schema: () => ({ state: secret, reasons: [secret] }),
  };
  const cases = workspaceToolIds.flatMap(id => Object.entries(faults).map(([fault, probe]) => ({ id, fault, probe })));
  it.each(cases)('$id / $fault preserves every other card byte-for-byte', async ({ id, fault, probe }) => {
    const baseline = await visionWorkspaceStatus('/fixture', fixtures());
    const deps = fixtures();
    deps.probes![id] = probe;
    const result = await visionWorkspaceStatus('/fixture', deps);
    expect(result.tools.map(tool => tool.id)).toEqual(workspaceToolIds);
    expect(result.checkedAt).toBe(baseline.checkedAt);
    for (const tool of result.tools) {
      if (tool.id !== id) expect(JSON.stringify(tool)).toBe(JSON.stringify(baseline.tools.find(other => other.id === tool.id)));
    }
    const affected = result.tools.find(tool => tool.id === id)!;
    expect(affected.state).toBe('not_configured');
    expect(affected.reasons?.length).toBe(1);
    if (fault === 'timeout') expect(affected.reasons).toEqual(['The local status probe timed out.']);
    if (fault === 'schema') expect(affected.reasons).toEqual(['The local status probe returned invalid output.']);
    const json = JSON.stringify(result);
    for (const privateForm of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) expect(json).not.toContain(privateForm);
  });

  it.each(['TIMMY_VISUAL_PYTHON', 'TIMMY_TELEMETRY_PYTHON'])('%s remains a safe per-entry status failure', async variable => {
    const baselineCatalog = integrationCatalog('/fixture', {});
    const env = { [variable]: secret };
    const changed = integrationCatalog('/fixture', env);
    const affected = variable === 'TIMMY_VISUAL_PYTHON' ? ['camera-fit'] : ['mcap', 'plotjuggler', 'cosmos'];
    expect(changed.map(tool => tool.id)).toEqual(baselineCatalog.map(tool => tool.id));
    for (const tool of changed) {
      if (affected.includes(tool.id)) {
        expect(tool.installedAdapter).toBe(false);
        expect(tool.configurationError).toBe(`${variable} must be an absolute interpreter path.`);
      } else expect(JSON.stringify(tool)).toBe(JSON.stringify(baselineCatalog.find(other => other.id === tool.id)));
    }
    expect(() => integrationDefinitions('/fixture', env)).toThrow(`${variable} must be an absolute interpreter path.`);
    const baseline = await visionWorkspaceStatus('/fixture', {
      now, getStatus: async () => ({ state: 'configured_unchecked', reasons: [] }), pathExists: () => false,
      catalog: () => baselineCatalog,
    });
    const result = await visionWorkspaceStatus('/fixture', {
      now, getStatus: async () => ({ state: 'configured_unchecked', reasons: [] }), pathExists: () => false,
      catalog: () => changed,
    });
    expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
    for (const privateForm of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) expect(JSON.stringify(changed)).not.toContain(privateForm);
    expect(integrationCatalogEntry('viser', '/fixture', env)).toEqual(integrationCatalogEntry('viser', '/fixture', {}));
  });

  it('isolates old dependency hooks without requiring custom probes', async () => {
    const result = await visionWorkspaceStatus('/fixture', {
      now,
      getStatus: async () => { throw new Error(secret); },
      catalog: () => { throw new Error('TIMMY_VISUAL_PYTHON must be an absolute interpreter path.'); },
      pathExists: () => { throw new Error(secret); },
    });
    expect(result.tools).toHaveLength(5);
    expect(result.tools.find(tool => tool.id === 'tldraw')?.state).toBe('available_unchecked');
    expect(result.tools.find(tool => tool.id === 'viser')?.reasons).toEqual(['TIMMY_VISUAL_PYTHON must be an absolute interpreter path.']);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(['viser', 'fiftyone'])('%s catalog schema failure leaves its peer unchanged', async id => {
    const catalog = () => [{ id: 'viser', installedAdapter: true }, { id: 'fiftyone', installedAdapter: true }];
    const deps = { now, getStatus: async () => ({ state: 'configured_unchecked', reasons: [] }), pathExists: () => false, catalog };
    const baseline = await visionWorkspaceStatus('/fixture', deps);
    const result = await visionWorkspaceStatus('/fixture', {
      ...deps, catalog: () => catalog().map(tool => tool.id === id ? { ...tool, installedAdapter: secret as unknown as boolean } : tool),
    });
    for (const tool of result.tools) {
      if (tool.id !== id) expect(JSON.stringify(tool)).toBe(JSON.stringify(baseline.tools.find(other => other.id === tool.id)));
    }
    expect(result.tools.find(tool => tool.id === id)?.reasons).toEqual(['The local status probe returned invalid output.']);
  });

  it.each(workspaceToolIds)('%s rejects invalid reason payloads', async (id: WorkspaceToolId) => {
    const deps = fixtures();
    deps.probes![id] = () => ({ state: 'available_unchecked', reasons: { secret } });
    const result = await visionWorkspaceStatus('/fixture', deps);
    expect(result.tools.find(tool => tool.id === id)?.reasons).toEqual(['The local status probe returned invalid output.']);
  });
});
