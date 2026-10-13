/**
 * Timmy Cloud's backend, slice 1: the agency credential, with REAL backend processes against the SIMULATED provider.
 *
 * The credential comes only from TIMMY_CLOUD_AGENCY_TOKEN or a secret file named at start that is private to its owner
 * (0600; a looser one is refused and nothing starts). A provider error that echoes the credential is redacted: a
 * planted credential appears in no response, no event, no log line and nothing the process prints.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { agencyCredential, http, MAIN, REPO_ROOT, spawnBackend, tempDir } from '../services/cloud/test-support.js';
import { SimulatedProvider } from '../services/cloud/simulated-provider.js';
import { REDACTED, newToken, sha256Hex } from '../services/cloud/redaction.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Starts main.ts with exactly these arguments and environment additions; resolves when it exits or listens. */
function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string; listening: boolean; stop(): Promise<void> }> {
  const base = { ...process.env };
  delete base.TIMMY_CLOUD_AGENCY_TOKEN;
  delete base.TIMMY_CLOUD_OPERATOR_TOKEN_SHA256;
  const child = spawn(process.execPath, ['--import', 'tsx', MAIN, ...args], { cwd: REPO_ROOT, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
  const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
  return new Promise((resolve) => {
    const stop = async (): Promise<void> => { child.kill('SIGTERM'); await exited; };
    child.stdout.on('data', () => { if (out.includes('"listening"')) resolve({ code: null, out, err, listening: true, stop }); });
    void exited.then((code) => resolve({ code, out, err, listening: false, stop }));
  });
}

describe('the agency credential at start', () => {
  const credential = agencyCredential();
  const operatorSha = sha256Hex(newToken());
  const dataDir = tempDir('timmy-cloud-start-');
  dirs.push(dataDir);
  const common = ['--data', join(dataDir, 'data'), '--provider-url', 'http://127.0.0.1:9', '--operator-token-sha256', operatorSha, '--tick-ms', '0'];

  it('refuses a secret file readable by others, in words with no path and no value, and starts nothing', async () => {
    const file = join(dataDir, 'agency-token');
    writeFileSync(file, `${credential}\n`);
    chmodSync(file, 0o644);
    const r = await run([...common, '--agency-token-file', file]);
    expect(r.listening).toBe(false);
    expect(r.code).toBe(2);
    expect(r.err).toBe('The secret file\'s permissions are 0644: it must be readable by its owner only (chmod 600). Nothing was started.\n');
    expect(r.out).toBe('');
    chmodSync(file, 0o600);
    const okRun = await run([...common, '--agency-token-file', file]);
    expect(okRun.listening, okRun.err).toBe(true);
    await okRun.stop();
    expect(okRun.err).toMatch(/agency credential from the secret file/);
    for (const text of [r.err, okRun.out, okRun.err]) { expect(text).not.toContain(credential); expect(text).not.toContain(dataDir); }
  }, 30_000);

  it('refuses to start with no credential, two sources, no operator hash, or a provider that is not the simulated one', async () => {
    const file = join(dataDir, 'agency-token-2');
    writeFileSync(file, credential, { mode: 0o600 });
    const cases: Array<[string[], Record<string, string>, RegExp]> = [
      [common, {}, /^No agency credential: set TIMMY_CLOUD_AGENCY_TOKEN, or name a secret file \(mode 0600\) with --agency-token-file\. Nothing was started\.\n$/],
      [[...common, '--agency-token-file', file], { TIMMY_CLOUD_AGENCY_TOKEN: credential }, /^Both a secret file and TIMMY_CLOUD_AGENCY_TOKEN were given/],
      [['--data', join(dataDir, 'data'), '--provider-url', 'http://127.0.0.1:9'], { TIMMY_CLOUD_AGENCY_TOKEN: credential }, /^No operator credential: give the sha256/],
      [[...common, '--provider', 'live'], { TIMMY_CLOUD_AGENCY_TOKEN: credential }, /^Only the simulated provider exists in this slice: no real provider is called/],
    ];
    for (const [args, env, words] of cases) {
      const r = await run(args, env);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(words);
      expect(r.err).not.toContain(credential);
    }
  }, 30_000);
});

describe('a planted credential appears in nothing the running backend writes or answers', () => {
  it('echoed back by a provider error, it is redacted from responses, events, the log and the process output', async () => {
    const credential = agencyCredential();
    const operatorToken = newToken();
    const sim = new SimulatedProvider({ credential });
    await sim.start();
    const dataDir = tempDir('timmy-cloud-plant-');
    dirs.push(dataDir);
    const b = await spawnBackend({ dataDir, providerUrl: sim.url, credential, operatorToken });
    const answers: string[] = [];
    try {
      expect(b.listening, b.stderr()).toBe(true);
      const op = async (method: string, path: string, body?: unknown) => { const r = await http(b.url, method, path, { token: operatorToken, body }); answers.push(r.text); return r; };
      const c = (await op('POST', '/v1/operator/customers', { limits: { per_order_cents: 5000, monthly_cents: 9000 }, subscription: 'active' })).json;
      sim.faults.push({ op: 'catalog', mode: 'echo_credential' }, { op: 'purchase', mode: 'echo_credential' });
      const created = await http(b.url, 'POST', '/v1/orders', { token: c.token, body: { kind: 'vps', item_id: 'sim-vps-small-1m' }, headers: { 'Idempotency-Key': 'k' } });
      answers.push(created.text);
      const id = created.json.order.order_id;
      await op('POST', `/v1/operator/orders/${id}/reconcile`);
      const approved = await op('POST', `/v1/operator/orders/${id}/approve`);
      expect(approved.json.order.steps.acceptance.provider_words).toContain(REDACTED);
      answers.push((await http(b.url, 'GET', `/v1/orders/${id}`, { token: c.token })).text);
      await op('GET', '/v1/operator/overview');
      const forms = [credential, Buffer.from(credential).toString('base64'), Buffer.from(`Bearer ${credential}`).toString('base64')];
      const logText = readFileSync(join(dataDir, 'backend.log'), 'utf8');
      const eventsText = readFileSync(join(dataDir, 'events.jsonl'), 'utf8');
      expect(logText).toContain(REDACTED);
      for (const text of [...answers, logText, eventsText, b.stdout(), b.stderr()]) for (const f of forms) expect(text.includes(f)).toBe(false);
      expect(eventsText).not.toContain(c.token);
      expect(eventsText).toContain(sha256Hex(c.token));
    } finally {
      b.child.kill('SIGTERM');
      await b.exited;
      await sim.close();
    }
  }, 30_000);
});
