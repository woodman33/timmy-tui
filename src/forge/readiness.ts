// Discovery only: DESIGN §1/§5.4, DOCTRINE §1–3, decisions D1/D4/D5.
// Never launch a server, invoke a Houdini tool, or write a receipt here.
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type ConfigurationStatus = 'not_checked' | 'flag_off' | 'missing' | 'invalid'
  | 'ambiguous' | 'disabled' | 'unresolved_environment' | 'configured' | 'missing_executable';
export interface ReadinessReport {
  scope: 'discovery_only';
  forge_enabled: boolean;
  houdini_enabled: boolean;
  cursor: { status: ConfigurationStatus; server?: string; executable_found?: boolean; launch?: 'python_module' | 'command' };
  timmy_wire: { via: 'cmcp'; status: 'flag_off' | 'unbound' };
  houdini_session: 'not_probed';
  canvases: Array<{ role: 'project' | 'template'; origin?: string; status: 'not_checked' | 'invalid_url' | 'http_responding' | 'http_error' | 'unreachable'; identity: 'not_verified' }>;
  cloud_advisory_configured: boolean;
  execution_ready: false;
  next_step: string;
}

export interface ReadinessOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  configPath?: string;
  serverName?: string;
  readConfig?: (path: string) => Promise<unknown>;
  executableExists?: (command: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
  canvasResponds?: (origin: string) => Promise<boolean>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function executableExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const candidates = isAbsolute(command) ? [command]
    : command.includes('/') ? []
      : (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch { /* next PATH entry */ }
  }
  return false;
}

function expandCommand(command: string, env: NodeJS.ProcessEnv, home: string): string | undefined {
  let unresolved = false;
  const expanded = command.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    if (env[key] === undefined) unresolved = true;
    return env[key] ?? '';
  });
  if (unresolved || expanded.includes('$') || !expanded.trim()) return undefined;
  return expanded.startsWith('~/') ? join(home, expanded.slice(2)) : expanded;
}

// Report only an origin. Reject credentials, query tokens, paths and redirects.
function localOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    return url.origin;
  } catch { return undefined; }
}

async function canvasResponds(origin: string): Promise<boolean> {
  const response = await fetch(origin, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
  await response.body?.cancel();
  return response.ok;
}

export async function inspectForgeReadiness(options: ReadinessOptions = {}): Promise<ReadinessReport> {
  const env = options.env ?? process.env;
  const forgeEnabled = env.TIMMY_FORGE === '1';
  const houdiniEnabled = env.TIMMY_HOUDINI_MCP === '1';
  const report: ReadinessReport = {
    scope: 'discovery_only', forge_enabled: forgeEnabled, houdini_enabled: houdiniEnabled,
    cursor: { status: 'not_checked' },
    timmy_wire: { via: 'cmcp', status: forgeEnabled && houdiniEnabled ? 'unbound' : 'flag_off' },
    houdini_session: 'not_probed',
    canvases: ['project', 'template'].map(role => ({ role: role as 'project' | 'template', status: 'not_checked', identity: 'not_verified' })),
    cloud_advisory_configured: false, execution_ready: false,
    next_step: 'Enable TIMMY_FORGE=1 to inspect configuration; this command does not enable execution.',
  };
  // D1: even configuration reads and HTTP checks are inert when Forge is off.
  if (!forgeEnabled) return report;
  report.cloud_advisory_configured = Boolean(env.SCENEFORGE_AGENT_KEY?.trim());
  report.next_step = 'Bind and verify the Houdini provider through the existing cmcp client-exec slot. No execution route is established by this diagnostic.';

  if (!houdiniEnabled) {
    report.cursor.status = 'flag_off';
    report.next_step = 'Set TIMMY_HOUDINI_MCP=1 to inspect the Cursor launch configuration. The Timmy cmcp provider binding is still unimplemented.';
  } else {
    const home = options.home ?? homedir();
    const configPath = options.configPath ?? env.TIMMY_HOUDINI_MCP_CONFIG ?? join(home, '.cursor', 'mcp.json');
    const reader = options.readConfig ?? (async path => JSON.parse(await readFile(path, 'utf8')) as unknown);
    try {
      const config = await reader(configPath);
      if (!record(config) || !record(config.mcpServers)) {
        report.cursor.status = 'invalid';
      } else {
        const requested = options.serverName ?? env.TIMMY_HOUDINI_MCP_SERVER;
        const entries = Object.entries(config.mcpServers).filter(([name]) => requested ? name === requested : /houdini/i.test(name));
        if (!entries.length) report.cursor.status = 'missing';
        else if (entries.length > 1) report.cursor.status = 'ambiguous';
        else {
          const [server, entry] = entries[0]!;
          if (!record(entry) || typeof entry.command !== 'string'
            || (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string')))) {
            report.cursor.status = 'invalid';
          } else if (entry.disabled === true) {
            report.cursor = { status: 'disabled', server };
          } else {
            const command = expandCommand(entry.command, env, home);
            if (!command) report.cursor = { status: 'unresolved_environment', server };
            else {
              const found = await (options.executableExists ?? executableExists)(command, env);
              const args = entry.args as string[] | undefined;
              report.cursor = { status: found ? 'configured' : 'missing_executable', server,
                executable_found: found, launch: args?.[0] === '-m' ? 'python_module' : 'command' };
            }
          }
        }
      }
    } catch (error) {
      // Neither raw JSON parser errors nor transport/config content may reach output.
      report.cursor = { status: record(error) && error.code === 'ENOENT' ? 'missing' : 'invalid' };
    }
  }

  // These checks do not identify tldraw, compile a board, or prove delivery.
  report.canvases = await Promise.all(report.canvases.map(async canvas => {
    const origin = localOrigin(canvas.role === 'project' ? 'http://localhost:4273' : env.TIMMY_SLATE_URL ?? 'http://localhost:5173');
    if (!origin) return { ...canvas, status: 'invalid_url' as const };
    try {
      const responding = await (options.canvasResponds ?? canvasResponds)(origin);
      return { ...canvas, origin, status: responding ? 'http_responding' as const : 'http_error' as const };
    } catch { return { ...canvas, origin, status: 'unreachable' as const }; }
  }));
  return report;
}

export function formatForgeReadiness(report: ReadinessReport): string {
  return [
    'Houdini / Timmy discovery',
    `Forge: ${report.forge_enabled ? 'enabled' : 'off'} · Houdini lane: ${report.houdini_enabled ? 'enabled' : 'off'}`,
    `Cursor configuration: ${report.cursor.status}${report.cursor.server ? ` (${report.cursor.server})` : ''}`,
    `Timmy cmcp route: ${report.timmy_wire.status}`,
    'Houdini session: not probed · execution ready: false',
    ...report.canvases.map(canvas => `${canvas.role} canvas: ${canvas.status} · identity not verified`),
    `Cloud advisory key present: ${report.cloud_advisory_configured} (separate from local execution)`,
    report.next_step,
  ].join('\n');
}

// Standalone entry point avoids modifying the shared CLI and TUI work in progress.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('TIMMY_FORGE=1 TIMMY_HOUDINI_MCP=1 npx tsx src/forge/readiness.ts [--json]\nOptional: TIMMY_HOUDINI_MCP_CONFIG, TIMMY_HOUDINI_MCP_SERVER, TIMMY_SLATE_URL.\nDiscovery only; does not start servers, invoke tools, or modify files.');
  } else if (args.some(arg => arg !== '--json')) {
    console.error('Unknown option. Use --help.');
    process.exitCode = 2;
  } else {
    const report = await inspectForgeReadiness();
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatForgeReadiness(report));
    // Successful discovery is not an execution approval or proof of readiness.
  }
}
