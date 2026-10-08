/**
 * Round R1, gap 1: a tool whose service is missing or failed says so. It never reports success, never
 * invents a job, a page snapshot, a screenshot or a benchmark, and never runs somewhere other than
 * where the operator approved (AGENTS.md §4: missing evidence is never synthesized into success).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserClickTool,
  browserScreenshotTool,
  browserSnapshotTool,
  cloudflareGetFeatureFlagTool,
  cloudflareSendDurablePulseTool,
  composioIntegrationTool,
  daytonaWorkspaceTool,
  envTool,
  neverSent,
  stressTestTool,
  triggerJobTool,
} from '../src/agent/tools.js';

/** A fetch failure the way Node's fetch reports one: a TypeError whose cause carries the code. */
const fetchFailed = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code}`), { code }) });

type Exec = (args: Record<string, unknown>) => Promise<any>;
const run = (t: unknown, args: Record<string, unknown> = {}): Promise<any> => (t as { function: { execute: Exec } }).function.execute(args);

const original = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-tools-'));
  process.env = { ...original };
  for (const k of ['DAYTONA_API_KEY', 'TRIGGER_SECRET_KEY', 'COMPOSIO_API_KEY', 'TIMMY_EDGE_HOST', 'CLOUDFLARE_FLAGSHIP_APP_ID']) delete process.env[k];
});

afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as { companionServer?: unknown }).companionServer;
  rmSync(dir, { recursive: true, force: true });
});

/** A PATH holding only programs written here; a fake program can record its arguments, one per line. */
function fakePath(programs: Record<string, string>): string {
  for (const [name, body] of Object.entries(programs)) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

describe('tools that need a service say when it is missing', () => {
  it('trigger_background_workflow: no key, no job; it names the key', async () => {
    const out = await run(triggerJobTool, { taskName: 'code-audit', payload: '{}' });
    expect(out.success).toBe(false);
    expect(out.jobId).toBe('');
    expect(out.message).toContain('TRIGGER_SECRET_KEY');
    expect(out.message).not.toMatch(/mock/i);
  });

  it('trigger_background_workflow: a failed request registers no job', async () => {
    process.env.TRIGGER_SECRET_KEY = 'tr_test_synthetic';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500, statusText: 'Server Error' })));
    const out = await run(triggerJobTool, { taskName: 'code-audit', payload: '{}' });
    expect(out).toMatchObject({ success: false, jobId: '' });
    expect(out.message).toContain('500');
  });

  it('trigger_background_workflow: a payload that is not JSON is refused before anything is sent', async () => {
    process.env.TRIGGER_SECRET_KEY = 'tr_test_synthetic';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const out = await run(triggerJobTool, { taskName: 'code-audit', payload: '{not json' });
    expect(out).toMatchObject({ success: false, jobId: '' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('manage_composio_integrations: no key, no connections; and it says which actions are not built', async () => {
    const none = await run(composioIntegrationTool, { action: 'list_connections' });
    expect(none).toMatchObject({ success: false, connections: [] });
    expect(none.message).toContain('COMPOSIO_API_KEY');
    process.env.COMPOSIO_API_KEY = 'ck_synthetic';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const notBuilt = await run(composioIntegrationTool, { action: 'trigger_action', appName: 'github' });
    expect(notBuilt).toMatchObject({ success: false, connections: [] });
    expect(notBuilt.message).toMatch(/not built/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('manage_composio_integrations: a failed request is a failure, with no connections made up', async () => {
    process.env.COMPOSIO_API_KEY = 'ck_synthetic';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); }));
    const out = await run(composioIntegrationTool, { action: 'list_connections' });
    expect(out).toMatchObject({ success: false, connections: [] });
    expect(out.message).toContain('ENOTFOUND');
  });

  it('stress_test_endpoint: without oha it says so instead of a simulated result', async () => {
    process.env.PATH = fakePath({});
    const out = await run(stressTestTool, { url: 'http://127.0.0.1:9/' });
    expect(out.success).toBe(false);
    expect(out.message).toContain('oha');
    expect(out.data).toBe('');
  });

  it('stress_test_endpoint: the address reaches oha as one argument, never through a shell', async () => {
    const log = join(dir, 'args.txt');
    const marker = join(dir, 'pwned');
    process.env.PATH = fakePath({ oha: `for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done; echo ok` });
    const url = `http://127.0.0.1:9/$(touch ${marker})`;
    const out = await run(stressTestTool, { url });
    expect(out.success).toBe(true);
    expect(readFileSync(log, 'utf8').split('\n')).toContain(url);
    expect(existsSync(marker)).toBe(false);
  });

  it('browser_get_snapshot: without agent-browser there is no snapshot, and no made-up page', async () => {
    process.env.PATH = fakePath({});
    const out = await run(browserSnapshotTool);
    expect(out.success).toBe(false);
    expect(out.accessibilityTree).not.toContain('Sign In');
    expect(out.accessibilityTree).toContain('agent-browser');
  });

  it('browser_click_element: the element reference is an argument, never shell text', async () => {
    const log = join(dir, 'args.txt');
    process.env.PATH = fakePath({ 'agent-browser': `for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done` });
    const out = await run(browserClickTool, { refId: '@e3' });
    expect(out.success).toBe(true);
    expect(readFileSync(log, 'utf8').split('\n')).toEqual(['--session', 'timmy', 'click', '@e3', '']);
  });

  it('browser_click_element: anything but a snapshot reference never reaches agent-browser (round R1 review)', async () => {
    const log = join(dir, 'args.txt');
    const marker = join(dir, 'pwned');
    process.env.PATH = fakePath({ 'agent-browser': `for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done` });
    for (const refId of [`1; touch ${marker}`, '--cdp=9222', '-h', 'e3 --headed']) {
      const out = await run(browserClickTool, { refId });
      expect(out.success, refId).toBe(false);
      expect(out.message, refId).toMatch(/^Not clicked/);
    }
    expect(existsSync(log)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('browser_click_element: a click that agent-browser could not make is a failure', async () => {
    process.env.PATH = fakePath({ 'agent-browser': 'echo "no element 7" >&2; exit 3' });
    const out = await run(browserClickTool, { refId: '7' });
    expect(out.success).toBe(false);
    expect(out.message).toContain('no element 7');
  });

  it('browser_take_screenshot: no file, no success, and no stock picture sent to the companion', async () => {
    process.env.PATH = fakePath({});
    const sendUpdate = vi.fn();
    (globalThis as { companionServer?: unknown }).companionServer = { sendUpdate };
    const out = await run(browserScreenshotTool);
    expect(out.success).toBe(false);
    expect(out.path).toBe('');
    expect(sendUpdate).not.toHaveBeenCalled();
  });

  it('cloudflare_get_feature_flag: a flag it could not read is not reported as read', async () => {
    const out = await run(cloudflareGetFeatureFlagTool, { flagKey: 'test' });
    expect(out.success).toBe(false);
    expect(out.message).not.toMatch(/verified/i);
    expect(out.message).toMatch(/not evaluated/i);
  });

  it('cloudflare_get_feature_flag: with no app ID set it names the setting and uses no built-in app (round R1 review)', async () => {
    const out = await run(cloudflareGetFeatureFlagTool, { flagKey: 'test' });
    expect(out).toMatchObject({ success: false, appId: '' });
    expect(out.message).toContain('CLOUDFLARE_FLAGSHIP_APP_ID is not set');
  });

  it('cloudflare_send_durable_pulse: a pulse that did not arrive gets no made-up ID', async () => {
    process.env.TIMMY_EDGE_HOST = 'edge.example.test';
    vi.stubGlobal('fetch', vi.fn(async () => { throw fetchFailed('ECONNREFUSED'); }));
    const out = await run(cloudflareSendDurablePulseTool, { metricName: 'cpu', metricValue: 1 });
    expect(out).toMatchObject({ success: false, pulseId: '' });
    expect(out.message).toContain('did not arrive');
    expect(out.message).toContain('ECONNREFUSED');
  });

  it('a connection that broke after sending is "outcome unknown", never "not run" (round R1 review)', async () => {
    process.env.TIMMY_EDGE_HOST = 'edge.example.test';
    process.env.TRIGGER_SECRET_KEY = 'tr_synthetic';
    vi.stubGlobal('fetch', vi.fn(async () => { throw fetchFailed('ECONNRESET'); }));
    const pulse = await run(cloudflareSendDurablePulseTool, { metricName: 'cpu', metricValue: 1 });
    expect(pulse.success).toBe(false);
    expect(pulse.message).toMatch(/^Outcome unknown/);
    const job = await run(triggerJobTool, { taskName: 'code-audit', payload: '{}' });
    expect(job).toMatchObject({ success: false, jobId: '' });
    expect(job.message).toMatch(/^Outcome unknown/);
    expect(job.message).toContain('may have started');
  });
});

describe('run_in_daytona_workspace runs only where it says', () => {
  it('without a key it runs on this machine and says so', async () => {
    const out = await run(daytonaWorkspaceTool, { command: 'echo hello' });
    expect(out.success).toBe(true);
    expect(out.where).toBe('this machine');
    expect(out.stdout.trim()).toBe('hello');
    expect(out.message).toContain('DAYTONA_API_KEY');
  });

  it('when Daytona fails, nothing runs on this machine instead', async () => {
    process.env.DAYTONA_API_KEY = 'dtn_synthetic';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502, statusText: 'Bad Gateway' })));
    const marker = join(dir, 'ran-locally');
    const out = await run(daytonaWorkspaceTool, { command: `touch ${marker}` });
    expect(out.success).toBe(false);
    expect(out.where).toBe('daytona');
    expect(out.message).toContain('502');
    expect(existsSync(marker)).toBe(false);
  });

  it('says "not run" only when the request never left, and "outcome unknown" when it may have run there', async () => {
    process.env.DAYTONA_API_KEY = 'dtn_synthetic';
    const marker = join(dir, 'ran-locally');
    vi.stubGlobal('fetch', vi.fn(async () => { throw fetchFailed('ECONNREFUSED'); }));
    const refused = await run(daytonaWorkspaceTool, { command: `touch ${marker}` });
    expect(refused).toMatchObject({ success: false, where: 'daytona' });
    expect(refused.message).toMatch(/^Not run: Daytona could not be reached/);
    vi.stubGlobal('fetch', vi.fn(async () => { throw fetchFailed('ECONNRESET'); }));
    const reset = await run(daytonaWorkspaceTool, { command: `touch ${marker}` });
    expect(reset).toMatchObject({ success: false, where: 'daytona' });
    expect(reset.message).toMatch(/^Outcome unknown: .* it may have run there\. Nothing ran on this machine\.$/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 200 })));
    const unreadable = await run(daytonaWorkspaceTool, { command: `touch ${marker}` });
    expect(unreadable.success).toBe(false);
    expect(unreadable.message).toMatch(/^Outcome unknown: Daytona answered HTTP 200 but its reply could not be read/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('neverSent', () => {
  it('is true only for errors that stop a request before it leaves this machine', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      expect(neverSent(fetchFailed(code)), code).toBe(true);
    }
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT']) {
      expect(neverSent(fetchFailed(code)), code).toBe(false);
    }
    expect(neverSent(new Error('no code at all'))).toBe(false);
    expect(neverSent(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([]), { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] }) }))).toBe(true);
  });
});

describe('get_env', () => {
  it('hides any variable whose name looks secret, not only five names', async () => {
    process.env.GITHUB_TOKEN = 'ghp_synthetic';
    process.env.MY_SERVICE_SECRET = 'synthetic';
    process.env.DB_PASSWORD = 'synthetic';
    process.env.STRIPE_API_KEY = 'sk_test_synthetic';
    process.env.TIMMY_PLAIN = 'visible';
    for (const name of ['GITHUB_TOKEN', 'MY_SERVICE_SECRET', 'DB_PASSWORD', 'STRIPE_API_KEY', 'openrouter_api_key']) {
      expect((await run(envTool, { name })).value, name).toBe('[REDACTED]');
    }
    expect((await run(envTool, { name: 'TIMMY_PLAIN' })).value).toBe('visible');
  });

  it('hides the names the review found, and any value that is a secret whatever its name (round R1 review)', async () => {
    for (const name of ['DB_PASS', 'SMTP_PASS', 'PGPASS', 'MYSQL_PWD', 'GITHUB_PAT', 'SIGNING_SALT', 'AZURE_STORAGE_CONNECTION_STRING']) {
      process.env[name] = 'synthetic';
      expect((await run(envTool, { name })).value, name).toBe('[REDACTED]');
    }
    // Credentials inside a URL, and token shapes, are hidden under any name (built here, not written out).
    process.env.DATABASE_URL = ['postgres://app:synthetic', 'db.example.test/app'].join(String.fromCharCode(64));
    process.env.ODD_NAME = ['gh', 'p_', 'a'.repeat(30)].join('');
    for (const name of ['DATABASE_URL', 'ODD_NAME']) expect((await run(envTool, { name })).value, name).toBe('[REDACTED]');
    // Plain values stay readable: PATH is not a PAT, and a URL with no credentials is not a secret.
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    expect((await run(envTool, { name: 'REDIS_URL' })).value).toBe('redis://127.0.0.1:6379');
    expect((await run(envTool, { name: 'PATH' })).value).toBe(process.env.PATH);
  });
});
