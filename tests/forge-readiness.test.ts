// Discovery contract: decisions D1/D5, DESIGN §1, DOCTRINE §1–3.
// All configuration, executable and HTTP probes are injected or mocked.
// No real server, filesystem mutation, generation or receipt chain is used.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatForgeReadiness,
  inspectForgeReadiness,
  type ReadinessOptions,
  type ReadinessReport,
} from '../src/forge/readiness.js';

const enabledEnv = (): NodeJS.ProcessEnv => ({
  TIMMY_FORGE: '1',
  TIMMY_HOUDINI_MCP: '1',
  PATH: '/example/bin',
});

const config = (entry: unknown = {
  command: '/example/python',
  args: ['-m', 'houdini_gen_mcp.server'],
}): unknown => ({ mcpServers: { houdini: entry } });

function options(overrides: ReadinessOptions = {}): ReadinessOptions {
  return {
    env: enabledEnv(),
    home: '/example/home',
    readConfig: vi.fn(async () => config()),
    executableExists: vi.fn(async () => true),
    canvasResponds: vi.fn(async () => true),
    ...overrides,
  };
}

function assertDiscoveryOnly(report: ReadinessReport): void {
  expect(report.scope).toBe('discovery_only');
  expect(report.execution_ready).toBe(false);
  expect(report.houdini_session).toBe('not_probed');
  expect(report.timmy_wire.via).toBe('cmcp');
  expect(report.canvases.every(canvas => canvas.identity === 'not_verified')).toBe(true);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Forge readiness remains inert when its flags are off', () => {
  it.each([undefined, '', '0', 'true'])('Forge=%s causes no configuration, executable or HTTP probes', async value => {
    const opts = options({ env: { TIMMY_FORGE: value, TIMMY_HOUDINI_MCP: '1', SCENEFORGE_AGENT_KEY: 'not-to-read' } });
    const report = await inspectForgeReadiness(opts);

    expect(opts.readConfig).not.toHaveBeenCalled();
    expect(opts.executableExists).not.toHaveBeenCalled();
    expect(opts.canvasResponds).not.toHaveBeenCalled();
    expect(report.cursor.status).toBe('not_checked');
    expect(report.timmy_wire.status).toBe('flag_off');
    expect(report.cloud_advisory_configured).toBe(false);
    expect(report.canvases.map(canvas => canvas.status)).toEqual(['not_checked', 'not_checked']);
    assertDiscoveryOnly(report);
  });

  it('Houdini flag off skips Cursor and executable discovery while allowing canvas checks', async () => {
    const opts = options({ env: { TIMMY_FORGE: '1' } });
    const report = await inspectForgeReadiness(opts);

    expect(opts.readConfig).not.toHaveBeenCalled();
    expect(opts.executableExists).not.toHaveBeenCalled();
    expect(opts.canvasResponds).toHaveBeenCalledTimes(2);
    expect(report.cursor.status).toBe('flag_off');
    expect(report.timmy_wire.status).toBe('flag_off');
    expect(report.canvases.map(canvas => canvas.status)).toEqual(['http_responding', 'http_responding']);
    assertDiscoveryOnly(report);
  });
});

describe('Cursor discovery describes configuration without claiming execution', () => {
  it('recognizes a configured Python module but keeps the Timmy route unbound', async () => {
    const opts = options();
    const report = await inspectForgeReadiness(opts);

    expect(opts.readConfig).toHaveBeenCalledWith('/example/home/.cursor/mcp.json');
    expect(opts.executableExists).toHaveBeenCalledWith('/example/python', opts.env);
    expect(report.cursor).toEqual({ status: 'configured', server: 'houdini', executable_found: true, launch: 'python_module' });
    expect(report.timmy_wire.status).toBe('unbound');
    assertDiscoveryOnly(report);
  });

  it('classifies an executable command separately from Python module startup', async () => {
    const report = await inspectForgeReadiness(options({ readConfig: async () => config({ command: 'houdini-mcp' }) }));
    expect(report.cursor.launch).toBe('command');
    expect(report.execution_ready).toBe(false);
  });

  it.each([
    ['empty server catalog', { mcpServers: {} }, 'missing'],
    ['no matching name', { mcpServers: { unrelated: { command: 'python' } } }, 'missing'],
    ['multiple matching names', { mcpServers: { houdini: { command: 'python' }, 'houdini-old': { command: 'python' } } }, 'ambiguous'],
    ['null root', null, 'invalid'],
    ['array root', [], 'invalid'],
    ['missing catalog', {}, 'invalid'],
    ['array catalog', { mcpServers: [] }, 'invalid'],
    ['null entry', config(null), 'invalid'],
    ['missing command', config({ args: [] }), 'invalid'],
    ['non-string command', config({ command: 12 }), 'invalid'],
    ['non-array arguments', config({ command: 'python', args: '-m server' }), 'invalid'],
    ['non-string argument', config({ command: 'python', args: ['-m', 7] }), 'invalid'],
    ['disabled entry', config({ command: 'python', disabled: true }), 'disabled'],
  ])('%s is diagnosed without probing an executable', async (_label, document, expectedStatus) => {
    const opts = options({ readConfig: async () => document });
    const report = await inspectForgeReadiness(opts);
    expect(report.cursor.status).toBe(expectedStatus);
    expect(opts.executableExists).not.toHaveBeenCalled();
    assertDiscoveryOnly(report);
  });

  it('an absent config file reports missing', async () => {
    const opts = options({ readConfig: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
    expect((await inspectForgeReadiness(opts)).cursor.status).toBe('missing');
    expect(opts.executableExists).not.toHaveBeenCalled();
  });

  it('explicit server selection resolves ambiguity, with options taking precedence over environment', async () => {
    const opts = options({
      env: { ...enabledEnv(), TIMMY_HOUDINI_MCP_SERVER: 'houdini-old', TIMMY_HOUDINI_MCP_CONFIG: '/env/mcp.json' },
      configPath: '/selected/mcp.json',
      serverName: 'houdini-current',
      readConfig: vi.fn(async () => ({ mcpServers: {
        'houdini-old': { command: '/old/python' },
        'houdini-current': { command: '/current/python', args: ['-m', 'houdini_gen_mcp.server'] },
      } })),
    });
    const report = await inspectForgeReadiness(opts);
    expect(opts.readConfig).toHaveBeenCalledWith('/selected/mcp.json');
    expect(opts.executableExists).toHaveBeenCalledWith('/current/python', opts.env);
    expect(report.cursor.server).toBe('houdini-current');
    expect(report.cursor.status).toBe('configured');
  });

  it('uses environment overrides when explicit options are absent', async () => {
    const opts = options({
      env: { ...enabledEnv(), TIMMY_HOUDINI_MCP_SERVER: 'dcc-local', TIMMY_HOUDINI_MCP_CONFIG: '/env/mcp.json' },
      readConfig: vi.fn(async () => ({ mcpServers: { 'dcc-local': { command: '/example/python' } } })),
    });
    expect((await inspectForgeReadiness(opts)).cursor.status).toBe('configured');
    expect(opts.readConfig).toHaveBeenCalledWith('/env/mcp.json');
  });

  it('a requested server name that does not exist never falls back to another entry', async () => {
    const opts = options({ serverName: 'missing-selected-server' });
    expect((await inspectForgeReadiness(opts)).cursor.status).toBe('missing');
    expect(opts.executableExists).not.toHaveBeenCalled();
  });

  it('a missing executable is distinct from a missing configuration', async () => {
    const report = await inspectForgeReadiness(options({ executableExists: async () => false }));
    expect(report.cursor).toEqual({ status: 'missing_executable', server: 'houdini', executable_found: false, launch: 'python_module' });
    assertDiscoveryOnly(report);
  });
});

describe('command expansion is explicit and does not evaluate shell expressions', () => {
  it.each([
    ['${PYTHON_BIN}', '/python-from-env'],
    ['${env:PYTHON_BIN}', '/python-from-env'],
    ['~/tools/python', '/example/home/tools/python'],
  ])('expands %s into the executable probe only', async (command, expanded) => {
    const opts = options({ env: { ...enabledEnv(), PYTHON_BIN: '/python-from-env' }, readConfig: async () => config({ command }) });
    const report = await inspectForgeReadiness(opts);
    expect(opts.executableExists).toHaveBeenCalledWith(expanded, opts.env);
    expect(report.cursor.status).toBe('configured');
    expect(JSON.stringify(report)).not.toContain(expanded);
  });

  it.each(['${MISSING_PYTHON}', '${env:MISSING_PYTHON}', '$PYTHON', '$(sensitive-command)', '', '   '])('does not resolve or execute %s', async command => {
    const opts = options({ readConfig: async () => config({ command }) });
    expect((await inspectForgeReadiness(opts)).cursor.status).toBe('unresolved_environment');
    expect(opts.executableExists).not.toHaveBeenCalled();
  });
});

describe('diagnostic output excludes credentials and raw failures', () => {
  const secret = 'fixture-credential-must-never-appear';

  it('reports only key presence and launch classification, without arguments or server environment', async () => {
    const document = config({ command: '/example/python', args: ['-m', 'houdini_gen_mcp.server', '--token', secret], env: { API_KEY: secret } });
    const env = { ...enabledEnv(), SCENEFORGE_AGENT_KEY: secret, UNRELATED_SECRET: secret };
    const envBefore = { ...env };
    const documentBefore = JSON.stringify(document);
    const report = await inspectForgeReadiness(options({ env, readConfig: async () => document }));

    expect(report.cloud_advisory_configured).toBe(true);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(formatForgeReadiness(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain('--token');
    expect(env).toEqual(envBefore);
    expect(JSON.stringify(document)).toBe(documentBefore);
    assertDiscoveryOnly(report);
  });

  it('does not expose parser error messages containing raw configuration', async () => {
    const report = await inspectForgeReadiness(options({ readConfig: async () => { throw new SyntaxError(`Unexpected token in ${secret}`); } }));
    expect(report.cursor.status).toBe('invalid');
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(formatForgeReadiness(report)).not.toContain(secret);
  });

  it('does not expose executable-probe or network errors', async () => {
    const report = await inspectForgeReadiness(options({
      executableExists: async () => { throw new Error(secret); },
      canvasResponds: async () => { throw new Error(secret); },
    }));
    expect(report.cursor.status).toBe('invalid');
    expect(report.canvases.every(canvas => canvas.status === 'unreachable')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(formatForgeReadiness(report)).not.toContain(secret);
  });

  it('an empty advisory key is not configured', async () => {
    const report = await inspectForgeReadiness(options({ env: { ...enabledEnv(), SCENEFORGE_AGENT_KEY: '   ' } }));
    expect(report.cloud_advisory_configured).toBe(false);
  });
});

describe('canvas checks are restricted to credential-free loopback origins', () => {
  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:5173/',
    'http://[::1]:5173',
  ])('permits %s while leaving canvas identity unverified', async url => {
    const opts = options({ env: { ...enabledEnv(), TIMMY_SLATE_URL: url } });
    const report = await inspectForgeReadiness(opts);
    const canvas = report.canvases.find(entry => entry.role === 'template')!;
    expect(opts.canvasResponds).toHaveBeenCalledWith(new URL(url).origin);
    expect(canvas.status).toBe('http_responding');
    expect(canvas.identity).toBe('not_verified');
    expect(report.execution_ready).toBe(false);
  });

  it.each([
    'https://localhost:5173',
    'http://example.com:5173',
    'http://localhost.example.com:5173',
    'http://192.168.1.2:5173',
    'http://localhost:5173/path',
    'http://localhost:5173/?token=fixture-url-secret',
    'http://fixture-url-secret@localhost:5173',
    'http://localhost:5173/#fixture-url-secret',
    'file:///tmp/canvas.html',
    'not a URL',
  ])('rejects %s without sending a template request or echoing the value', async url => {
    const opts = options({ env: { ...enabledEnv(), TIMMY_SLATE_URL: url } });
    const report = await inspectForgeReadiness(opts);
    const canvas = report.canvases.find(entry => entry.role === 'template')!;
    expect(canvas.status).toBe('invalid_url');
    expect(canvas.origin).toBeUndefined();
    expect(opts.canvasResponds).toHaveBeenCalledTimes(1);
    expect(opts.canvasResponds).toHaveBeenCalledWith('http://localhost:4273');
    expect(JSON.stringify(report)).not.toContain('fixture-url-secret');
    expect(formatForgeReadiness(report)).not.toContain(url);
  });

  it('distinguishes an HTTP error response from an unreachable service', async () => {
    const report = await inspectForgeReadiness(options({ canvasResponds: async origin => {
      if (origin.endsWith(':4273')) return false;
      throw new Error('connection refused');
    } }));
    expect(report.canvases.map(canvas => canvas.status)).toEqual(['http_error', 'unreachable']);
    assertDiscoveryOnly(report);
  });

  it('the default HTTP probe does not follow redirects and cancels response bodies', async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: false, status: 302, body: { cancel } }));
    vi.stubGlobal('fetch', fetchMock);
    const opts = options();
    delete opts.canvasResponds;
    const report = await inspectForgeReadiness(opts);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual' });
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(report.canvases.every(canvas => canvas.status === 'http_error')).toBe(true);
  });

  it('an unrelated service returning 200 is only HTTP responding, never verified tldraw', async () => {
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: { cancel } })));
    const opts = options();
    delete opts.canvasResponds;
    const report = await inspectForgeReadiness(opts);
    expect(report.canvases.every(canvas => canvas.status === 'http_responding')).toBe(true);
    assertDiscoveryOnly(report);
  });
});

describe('human-readable and JSON output preserve the same evidence limits', () => {
  it.each([false, true])('formats flags, wire status and canvas states consistently (enabled=%s)', async enabled => {
    const report = await inspectForgeReadiness(options({ env: enabled ? enabledEnv() : {} }));
    const json = JSON.parse(JSON.stringify(report)) as ReadinessReport;
    const text = formatForgeReadiness(report);

    expect(text).toContain(`Forge: ${json.forge_enabled ? 'enabled' : 'off'}`);
    expect(text).toContain(`Houdini lane: ${json.houdini_enabled ? 'enabled' : 'off'}`);
    expect(text).toContain(`Cursor configuration: ${json.cursor.status}`);
    expect(text).toContain(`Timmy cmcp route: ${json.timmy_wire.status}`);
    expect(text).toContain('Houdini session: not probed · execution ready: false');
    expect(text).toContain(`Cloud advisory key present: ${json.cloud_advisory_configured}`);
    for (const canvas of json.canvases) {
      expect(text).toContain(`${canvas.role} canvas: ${canvas.status} · identity not verified`);
    }
    expect(text).toContain(json.next_step);
    assertDiscoveryOnly(json);
  });
});
