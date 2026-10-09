import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { spawnProcess } from '../runtime/spawn-runtime.js';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { spatialModelCatalogTool, spatialModelContextTool, spatialModelReviewTool } from './spatial-model-tools.js';
import { z } from 'zod/v4';
import { edgeUrl, operatorLabel } from '../utils/edge-host.js';
import { timmyHome } from '../utils/init.js';
import { keyMissing, secretEnvName, secretEnvValue } from '../utils/keys.js';
import { onPath } from '../utils/on-path.js';

/*
 * Round R1 (AGENTS.md §4): a tool whose service is missing or failed says so, with the step that sets it
 * up. It never reports success it did not have, never invents a job, a page or a picture, and never runs
 * somewhere other than where the operator approved. Programs run with arguments, never through a shell,
 * except the workspace command, whose whole job is a shell command (and NEEDS YOU asks for each one).
 */

export { keyMissing };

interface ProgramRun {
  ok: boolean;
  /** The program is not installed (not on PATH). */
  missing: boolean;
  stdout: string;
  /** Why it failed: its own error output, or what stopped it. */
  error?: string;
}

/** Runs `program` with `args` as separate arguments, never through a shell. */
function runProgram(program: string, args: string[], timeoutMs: number): Promise<ProgramRun> {
  if (!onPath(program)) return Promise.resolve({ ok: false, missing: true, stdout: '' });
  return new Promise((resolve) => {
    execFile(program, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, missing: false, stdout: stdout ?? '' });
      const err = error as NodeJS.ErrnoException & { killed?: boolean };
      if (err.code === 'ENOENT') return resolve({ ok: false, missing: true, stdout: '' });
      const why = err.killed ? `${program} did not finish within ${Math.round(timeoutMs / 1000)} s` : (String(stderr ?? '').trim() || err.message);
      resolve({ ok: false, missing: false, stdout: stdout ?? '', error: why.slice(0, 500) });
    });
  });
}

const reason = (err: unknown): string => {
  const cause = (err as { cause?: { message?: unknown } })?.cause?.message;
  const top = err instanceof Error ? err.message : String(err);
  return typeof cause === 'string' && cause && !top.includes(cause) ? `${top}: ${cause}` : top;
};

/** Error codes that mean the request never left this machine: no connection, no address, no TLS. */
const BEFORE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'ERR_INVALID_URL', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Whether a failed request certainly never reached the service, so nothing can have run there (round
 * R1 review). A reset or a timeout after the request went out leaves the outcome unknown, and the tool
 * says so instead of "not run".
 */
export function neverSent(err: unknown): boolean {
  const codes: string[] = [];
  let e = err as { code?: unknown; errors?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 4; depth++) {
    if (typeof e.code === 'string') codes.push(e.code);
    if (Array.isArray(e.errors)) for (const x of e.errors as Array<{ code?: unknown }>) if (typeof x?.code === 'string') codes.push(x.code);
    e = e.cause as typeof e;
  }
  return codes.length > 0 && codes.every((c) => BEFORE_SEND.has(c) || /CERT|TLS|SSL/.test(c));
}

export const currentTimeTool = tool({
  name: 'get_current_time',
  description: 'Get the current date and time in any timezone',
  inputSchema: z.object({
    timezone: z.string().optional().describe('Timezone (e.g., "UTC", "America/New_York")'),
  }),
  outputSchema: z.object({
    time: z.string(),
    timezone: z.string(),
    iso: z.string(),
  }),
  execute: async ({ timezone }: { timezone?: string }) => {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      time: new Date().toLocaleString('en-US', { timeZone: tz }),
      timezone: tz,
      iso: new Date().toISOString(),
    };
  },
} as any);

export const calculatorTool = tool({
  name: 'calculate',
  description: 'Evaluate a mathematical expression',
  inputSchema: z.object({
    expression: z.string().describe('Math expression (e.g., "2 + 2", "2**10")'),
  }),
  outputSchema: z.object({
    expression: z.string(),
    result: z.number(),
  }),
  execute: async ({ expression }: { expression: string }) => {
    const sanitized = expression.replace(/[^0-9+\-*/().%,e ^]/g, '').replace(/\^/g, '**');
    try {
      const fn = new Function(`"use strict"; return (${sanitized})`);
      const result = fn();
      return { expression, result: Number(result) };
    } catch (e) {
      throw new Error(`Invalid expression: ${expression}`);
    }
  },
} as any);

export const systemInfoTool = tool({
  name: 'get_system_info',
  description: 'Get system information (platform, arch, memory, uptime)',
  inputSchema: z.object({}),
  outputSchema: z.object({
    platform: z.string(),
    arch: z.string(),
    memory: z.object({ total: z.number(), free: z.number() }),
    uptime: z.number(),
    node: z.string(),
  }),
  execute: async () => {
    const os = await import('os');
    return {
      platform: os.platform(),
      arch: os.arch(),
      memory: { total: os.totalmem(), free: os.freemem() },
      uptime: os.uptime(),
      node: process.version,
    };
  },
} as any);

export const envTool = tool({
  name: 'get_env',
  description: 'Get environment variable value (filters sensitive keys automatically)',
  inputSchema: z.object({
    name: z.string().describe('Environment variable name'),
  }),
  outputSchema: z.object({
    name: z.string(),
    value: z.string().nullable(),
  }),
  execute: async ({ name }: { name: string }) => {
    // A name that looks like it holds a secret is hidden, and so is a value that is one whatever its
    // name (a password inside DATABASE_URL, a token in an oddly named variable): round R1 review.
    if (secretEnvName(name)) return { name, value: '[REDACTED]' };
    const value = process.env[name];
    if (value !== undefined && secretEnvValue(value)) return { name, value: '[REDACTED]' };
    return { name, value: value ?? null };
  },
} as any);

export const daytonaWorkspaceTool = tool({
  name: 'run_in_daytona_workspace',
  description:
    'Runs a shell command in a Daytona workspace when DAYTONA_API_KEY is set; without it, the command runs on this machine ' +
    '(the operator approves each command). The answer says where it ran.',
  inputSchema: z.object({
    command: z.string().describe('The shell command to run in the workspace (e.g. "git status", "npm run build").'),
    workspaceId: z.string().optional().describe('Optional workspace ID to target. If not provided, targets default TUI sandbox.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    where: z.enum(['this machine', 'daytona']),
    stdout: z.string(),
    stderr: z.string(),
    message: z.string(),
  }),
  execute: async ({ command, workspaceId }: { command: string; workspaceId?: string }) => {
    const key = process.env.DAYTONA_API_KEY;
    const url = process.env.DAYTONA_SERVER_URL || 'https://api.daytona.io';

    if (keyMissing(key)) {
      // No Daytona: the command runs here, which is what the approval box said before the operator agreed.
      // R1 workspace direction: in its own process group with a time limit, so a command that keeps running
      // (a dev server) cannot hold the turn open, and a stop takes its process group with it.
      const limit = Number(process.env.TIMMY_WORKSPACE_TIMEOUT_MS) > 0 ? Number(process.env.TIMMY_WORKSPACE_TIMEOUT_MS) : 120_000;
      const { outcome } = spawnProcess('sh', ['-c', command], { detached: true, timeoutMs: limit, maxBuffer: 10 * 1024 * 1024 });
      const r = await outcome;
      const exit = r.timedOut ? '' : r.error ? ` ${r.error}.` : r.status !== 0 ? ` Exit ${r.status ?? r.signal ?? 'error'}.` : '';
      return {
        success: r.status === 0 && !r.timedOut && !r.error,
        where: 'this machine',
        stdout: r.stdout,
        stderr: r.stderr || r.error || '',
        message: r.timedOut
          ? `Stopped after ${Math.round(limit / 1000)} s on this machine, with its process group. A command that keeps running, such as a dev server, belongs in /preview, which runs it as a job.`
          : `Ran on this machine, not in Daytona: DAYTONA_API_KEY is not set.${exit}`,
      };
    }

    const targetWorkspace = workspaceId || 'timmy-tui-sandbox';
    // When Daytona fails, nothing runs here instead: the operator approved a Daytona run, not a local one.
    const failed = (why: string) => ({ success: false, where: 'daytona' as const, stdout: '', stderr: '', message: `Not run: ${why}. Nothing ran on this machine.` });
    try {
      const response = await fetch(`${url}/api/v1/workspaces/${encodeURIComponent(targetWorkspace)}/exec`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ command })
      });
      if (!response.ok) return failed(`Daytona answered HTTP ${response.status} ${response.statusText}`.trim());
      const data = await response.json().catch(() => null) as any;
      if (!data || typeof data !== 'object') {
        return { success: false, where: 'daytona', stdout: '', stderr: '', message: `Outcome unknown: Daytona answered HTTP ${response.status} but its reply could not be read; the command may have run there. Nothing ran on this machine.` };
      }
      return {
        success: data.exitCode === 0,
        where: 'daytona',
        stdout: data.stdout || '',
        stderr: data.stderr || '',
        message: `Ran in Daytona workspace "${targetWorkspace}" (exit ${data.exitCode ?? 'unknown'}).`,
      };
    } catch (err) {
      if (neverSent(err)) return failed(`Daytona could not be reached (${reason(err)})`);
      return { success: false, where: 'daytona', stdout: '', stderr: '', message: `Outcome unknown: the connection to Daytona failed after the command was sent (${reason(err)}); it may have run there. Nothing ran on this machine.` };
    }
  }
} as any);

export const triggerJobTool = tool({
  name: 'trigger_background_workflow',
  description: 'Triggers an asynchronous background task in Trigger.dev for long-running audits or builds. Needs TRIGGER_SECRET_KEY.',
  inputSchema: z.object({
    taskName: z.string().describe('The name/ID of the background task to run (e.g. "code-audit", "test-suite").'),
    payload: z.string().describe('JSON payload to pass to the Trigger.dev background worker task.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    jobId: z.string(),
    message: z.string(),
  }),
  execute: async ({ taskName, payload }: { taskName: string; payload: string }) => {
    const key = process.env.TRIGGER_SECRET_KEY;
    const url = process.env.TRIGGER_API_URL || 'https://api.trigger.dev';
    const notTriggered = (why: string) => ({ success: false, jobId: '', message: `Not triggered: ${why}` });

    if (keyMissing(key)) return notTriggered('TRIGGER_SECRET_KEY is not set. Set it to a Trigger.dev secret key to use this tool.');
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return notTriggered('the payload is not valid JSON.');
    }
    try {
      const response = await fetch(`${url}/api/v1/tasks/${encodeURIComponent(taskName)}/trigger`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ payload: body })
      });
      if (!response.ok) return notTriggered(`Trigger.dev answered HTTP ${response.status} ${response.statusText}`.trim() + '.');
      const data = await response.json().catch(() => ({})) as any;
      const id = typeof data?.id === 'string' ? data.id : '';
      return {
        success: true,
        jobId: id,
        message: id ? `Triggered "${taskName}" on Trigger.dev (run ${id}).` : `Trigger.dev accepted "${taskName}" but returned no run ID to follow.`,
      };
    } catch (err) {
      if (neverSent(err)) return notTriggered(`Trigger.dev could not be reached (${reason(err)}).`);
      return { success: false, jobId: '', message: `Outcome unknown: the connection to Trigger.dev failed after the request was sent (${reason(err)}); "${taskName}" may have started.` };
    }
  }
} as any);

export const composioIntegrationTool = tool({
  name: 'manage_composio_integrations',
  description: 'Lists your Composio connections (list_connections). Needs COMPOSIO_API_KEY. The other actions are not built yet.',
  inputSchema: z.object({
    action: z.enum(['list_connections', 'check_updates', 'trigger_action']).describe('The integration action to perform on Composio.'),
    appName: z.string().optional().describe('Optional application name (e.g., "github", "slack") to look for.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    status: z.string(),
    connections: z.array(z.string()),
    message: z.string(),
  }),
  execute: async ({ action, appName }: { action: 'list_connections' | 'check_updates' | 'trigger_action'; appName?: string }) => {
    const apiKey = process.env.COMPOSIO_API_KEY;

    if (keyMissing(apiKey)) {
      return { success: false, status: 'NOT_CONFIGURED', connections: [], message: 'Not connected: COMPOSIO_API_KEY is not set. Set it to a Composio API key to list your connections.' };
    }
    if (action !== 'list_connections') {
      return { success: false, status: 'NOT_BUILT', connections: [], message: `Not built: this tool only lists connections (list_connections); "${action}" does nothing yet.` };
    }
    try {
      const response = await fetch('https://api.composio.dev/v1/connections', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey!,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) return { success: false, status: 'ERROR', connections: [], message: `Composio answered HTTP ${response.status}.` };
      const data = await response.json() as any;
      const all: string[] = (data.connections || []).map((c: any) => String(c.name || c.app || '')).filter(Boolean);
      const connections = appName ? all.filter((c) => c.toLowerCase().includes(appName.toLowerCase())) : all;
      return {
        success: true,
        status: 'ACTIVE',
        connections,
        message: `Composio lists ${connections.length} ${connections.length === 1 ? 'connection' : 'connections'}${appName ? ` matching "${appName}"` : ''}: ${connections.join(', ') || 'none'}.`,
      };
    } catch (err) {
      return { success: false, status: 'ERROR', connections: [], message: `Composio could not be reached: ${reason(err)}.` };
    }
  }
} as any);

export const stressTestTool = tool({
  name: 'stress_test_endpoint',
  description: 'Stress-tests an HTTP endpoint with the local oha program and returns its report. Needs oha installed.',
  inputSchema: z.object({
    url: z.string().url().describe('The target URL to stress test.'),
    requests: z.number().int().positive().optional().describe('Total requests to send (default 20).'),
    concurrency: z.number().int().positive().optional().describe('Concurrent connections (default 4).'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    data: z.string(),
  }),
  execute: async ({ url, requests = 20, concurrency = 4 }: { url: string; requests?: number; concurrency?: number }) => {
    const r = await runProgram('oha', ['-n', String(requests), '-c', String(concurrency), '--no-tui', url], 120_000);
    if (r.missing) return { success: false, message: 'Not run: oha is not installed (macOS: brew install oha).', data: '' };
    if (!r.ok) return { success: false, message: `oha failed: ${r.error}`, data: r.stdout };
    return { success: true, message: `oha sent ${requests} requests to ${url}, ${concurrency} at a time.`, data: r.stdout };
  }
} as any);

/** The browser tools drive agent-browser's `timmy` session; each says plainly when it is not installed. */
const AGENT_BROWSER_MISSING = 'agent-browser is not installed (not on PATH), so no browser was used.';
const browser = (args: string[], timeoutMs = 30_000): Promise<ProgramRun> => runProgram('agent-browser', ['--session', 'timmy', ...args], timeoutMs);

export const browserOpenTool = tool({
  name: 'browser_launch_cdp',
  description: 'Opens a URL in agent-browser\'s Chrome session (needs agent-browser installed).',
  inputSchema: z.object({
    url: z.string().url().describe('Target URL to load.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ url }: { url: string }) => {
    const r = await browser(['open', url]);
    if (r.missing) return { success: false, message: AGENT_BROWSER_MISSING };
    if (!r.ok) return { success: false, message: `agent-browser could not open ${url}: ${r.error}` };
    return { success: true, message: `Opened ${url} in agent-browser (session timmy).` };
  }
} as any);

export const browserSnapshotTool = tool({
  name: 'browser_get_snapshot',
  description: 'Returns the interactive elements and accessibility tree of the page open in agent-browser.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    accessibilityTree: z.string(),
  }),
  execute: async () => {
    const r = await browser(['snapshot']);
    if (r.missing) return { success: false, accessibilityTree: AGENT_BROWSER_MISSING };
    if (!r.ok) return { success: false, accessibilityTree: `agent-browser could not take a snapshot: ${r.error}` };
    return { success: true, accessibilityTree: r.stdout };
  }
} as any);

export const browserClickTool = tool({
  name: 'browser_click_element',
  description: 'Clicks an element of the page open in agent-browser, by the numeric reference from browser_get_snapshot.',
  inputSchema: z.object({
    refId: z.string().describe('Target element numeric ID reference.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ refId }: { refId: string }) => {
    // Only a snapshot reference (12, e12 or @e12) reaches agent-browser: a value like --cdp=9222 would
    // arrive as an option, not an element (round R1 review).
    if (!/^@?e?\d+$/i.test(refId.trim())) return { success: false, message: `Not clicked: "${refId}" is not an element reference from browser_get_snapshot (like @e3).` };
    const r = await browser(['click', refId.trim()]);
    if (r.missing) return { success: false, message: AGENT_BROWSER_MISSING };
    if (!r.ok) return { success: false, message: `agent-browser could not click [${refId}]: ${r.error}` };
    return { success: true, message: `Clicked element [${refId}].` };
  }
} as any);

export const browserScreenshotTool = tool({
  name: 'browser_take_screenshot',
  description: 'Saves a PNG screenshot of the page open in agent-browser into Timmy\'s home (screenshots/) and returns its path.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    path: z.string(),
    message: z.string(),
  }),
  execute: async () => {
    if (!onPath('agent-browser')) return { success: false, path: '', message: AGENT_BROWSER_MISSING };
    // Into Timmy's own home, never the operator's Desktop: this tool runs without asking.
    const dir = join(timmyHome(), 'screenshots');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    const r = await browser(['screenshot', path]);
    if (!r.ok || !existsSync(path)) return { success: false, path: '', message: `No screenshot: ${r.error ?? 'agent-browser wrote no file'}.` };
    // The companion viewer gets this picture, never a stand-in.
    const companion = (globalThis as any).companionServer;
    if (companion) companion.sendUpdate('media', { mediaType: 'image', data: `data:image/png;base64,${readFileSync(path).toString('base64')}`, name: basename(path) });
    return { success: true, path, message: `Screenshot saved: ${path}` };
  }
} as any);

export const cloudflareGetFeatureFlagTool = tool({
  name: 'cloudflare_get_feature_flag',
  description: 'Evaluates a Cloudflare Flagship feature flag through OpenFeature. Outside a Worker with a Flagship binding it reports that it could not.',
  inputSchema: z.object({
    flagKey: z.string().describe('The key of the feature flag to evaluate (e.g. "test").'),
    defaultValue: z.boolean().optional().describe('Fallback value if the flag is missing (default false).'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    flagKey: z.string(),
    value: z.boolean(),
    appId: z.string(),
    message: z.string(),
  }),
  execute: async ({ flagKey, defaultValue = false }: { flagKey: string; defaultValue?: boolean }) => {
    // No built-in app ID: a flag is read from the operator's own Flagship app or not at all.
    const appId = process.env.CLOUDFLARE_FLAGSHIP_APP_ID?.trim() ?? '';
    const notEvaluated = (why: string) => ({
      success: false,
      flagKey,
      value: defaultValue,
      appId,
      message: `Not evaluated: ${why}. ${defaultValue} is only the default you gave, not the flag's value.`,
    });
    if (!appId) return notEvaluated('CLOUDFLARE_FLAGSHIP_APP_ID is not set');
    try {
      const { OpenFeature } = await import('@openfeature/server-sdk');
      const { FlagshipServerProvider } = await import('@cloudflare/flagship/server' as any);
      await OpenFeature.setProviderAndWait(new FlagshipServerProvider({ binding: appId }));
      // OpenFeature hands back the default when evaluation fails; the details say whether it did.
      const details = await OpenFeature.getClient().getBooleanDetails(flagKey, defaultValue);
      if (details.errorCode || details.reason === 'ERROR') return notEvaluated(details.errorMessage || String(details.errorCode || 'the provider reported an error'));
      return { success: true, flagKey, value: details.value, appId, message: `Flag "${flagKey}" is ${details.value} (Flagship, reason ${details.reason ?? 'unknown'}).` };
    } catch (err) {
      return notEvaluated(reason(err));
    }
  }
} as any);

export const cloudflareSendDurablePulseTool = tool({
  name: 'cloudflare_send_durable_pulse',
  description: 'Sends a metric pulse to your Durable Object on Cloudflare (needs TIMMY_EDGE_HOST).',
  inputSchema: z.object({
    metricName: z.string().describe('The name of the metric to log (e.g. "system_cpu", "active_users").'),
    metricValue: z.number().describe('The numerical value of the metric to pulse.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    pulseId: z.string(),
    workerUrl: z.string(),
    message: z.string(),
  }),
  execute: async ({ metricName, metricValue }: { metricName: string; metricValue: number }) => {
    const workerUrl = edgeUrl(); // throws the inert line when unresolved
    const missed = (why: string) => ({ success: false, pulseId: '', workerUrl, message: `The pulse did not arrive: ${why}.` });
    try {
      const response = await fetch(`${workerUrl}/pulse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Operator': operatorLabel()
        },
        body: JSON.stringify({
          metric: metricName,
          value: metricValue,
          timestamp: Date.now()
        })
      });
      if (!response.ok) return missed(`the Durable Object answered HTTP ${response.status}`);
      const data = await response.json().catch(() => ({})) as any;
      const id = typeof data?.id === 'string' ? data.id : '';
      return {
        success: true,
        pulseId: id,
        workerUrl,
        message: `Pulse [${metricName}: ${metricValue}] accepted by the Durable Object${id ? ` (ID ${id})` : ', which returned no ID'}.`,
      };
    } catch (err) {
      if (neverSent(err)) return missed(`the Durable Object could not be reached (${reason(err)})`);
      return { success: false, pulseId: '', workerUrl, message: `Outcome unknown: the connection failed after the pulse was sent (${reason(err)}); it may have arrived.` };
    }
  }
} as any);

export const listCardTool = tool({
  name: 'list_card',
  description: 'List a live card for sale on Break Mode Engine / Cloudflare Worker',
  inputSchema: z.object({
    username: z.string().optional().describe('Username/Card target to list (defaults to TIMMY_USERNAME env var)'),
    askPrice: z.number().optional().describe('Optional ask price'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    checkoutLink: z.string().optional(),
    buyLink: z.string().optional(),
    listReceiptId: z.string().optional(),
    confidence: z.number().optional(),
    message: z.string(),
  }),
  execute: async ({ username, askPrice }: { username?: string; askPrice?: number }) => {
    const rawBaseUrl = process.env.BREAK_MODE_API_BASE_URL || process.env.API_BASE_URL;
    if (!rawBaseUrl) {
      throw new Error('API_BASE_URL is REQUIRED');
    }

    const resolvedUser = username || process.env.TIMMY_USERNAME;
    if (!resolvedUser) {
      throw new Error('Username is required');
    }

    const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl.slice(0, -1) : rawBaseUrl;

    let liveData: any;
    try {
      const liveRes = await fetch(`${baseUrl}/api/live/${resolvedUser}`);
      liveData = await liveRes.json();
    } catch (err: any) {
      return {
        success: false,
        message: `✕ Network/unreachable error fetching live card: ${err.message}`,
      };
    }

    if (liveData.pricingSource !== 'live') {
      return {
        success: false,
        message: 'pricing not live — refusing to list',
      };
    }

    const listRes = await fetch(`${baseUrl}/api/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: resolvedUser,
        cardId: liveData.cardId,
        askPrice: askPrice || liveData.price,
      }),
    });

    if (listRes.status === 409) {
      const confPercent = Math.round((liveData.confidence || 0) * 100);
      return {
        success: false,
        confidence: liveData.confidence,
        message: `✕ Card needs confirmation. Confidence is only ${confPercent}%. Do NOT retry-force it.`,
      };
    }

    if (!listRes.ok) {
      return {
        success: false,
        confidence: liveData.confidence,
        message: `✕ Listing failed with status ${listRes.status}`,
      };
    }

    const resData = (await listRes.json()) as any;
    const confPercent = Math.round((liveData.confidence || 0) * 100);
    return {
      success: true,
      checkoutLink: resData.checkoutLink,
      buyLink: resData.buyLink,
      listReceiptId: resData.listReceiptId,
      confidence: liveData.confidence,
      message: `${confPercent}% confident, FMV $${liveData.price} for ${liveData.name} — listing now.\nCheckout: ${resData.checkoutLink}\nBuy: ${resData.buyLink}\nReceipt: ${resData.listReceiptId}\npushed live to overlay`,
    };
  },
} as any);

export const defaultTools = [
  spatialModelCatalogTool,
  spatialModelContextTool,
  spatialModelReviewTool,
  currentTimeTool,
  calculatorTool,
  systemInfoTool,
  envTool,
  daytonaWorkspaceTool,
  triggerJobTool,
  composioIntegrationTool,
  stressTestTool,
  browserOpenTool,
  browserSnapshotTool,
  browserClickTool,
  browserScreenshotTool,
  cloudflareGetFeatureFlagTool,
  cloudflareSendDurablePulseTool,
  listCardTool
];
