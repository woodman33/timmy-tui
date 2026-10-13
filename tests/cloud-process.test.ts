/**
 * Timmy Cloud's backend, slice 1: the SIMULATED provider and the backend as two processes, started the way a person
 * trying it by hand would start them (docs/ui-cockpit/TIMMY-CLOUD.md, "Trying it by hand"), with one order through
 * the HTTP API. No real provider is called.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { agencyCredential, http, REPO_ROOT, spawnBackend, tempDir } from '../services/cloud/test-support.js';
import { newToken } from '../services/cloud/redaction.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('two processes, by hand', () => {
  it('the simulated provider\'s own process and the backend\'s: a domain ordered, approved and registered', async () => {
    const credential = agencyCredential();
    const env = { ...process.env, TIMMY_CLOUD_AGENCY_TOKEN: credential };
    const sim = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'services', 'cloud', 'simulated-main.ts')], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    sim.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    const simExited = new Promise<number | null>((r) => sim.once('exit', (c) => r(c)));
    await new Promise<void>((resolve, reject) => {
      sim.stdout.on('data', () => { if (out.includes('"listening"')) resolve(); });
      void simExited.then(() => reject(new Error('the simulated provider did not start')));
    });
    const simUrl = (JSON.parse(out.trim().split('\n')[0]) as { listening: string; simulated: boolean });
    expect(simUrl.simulated).toBe(true);
    const dataDir = tempDir('timmy-cloud-hand-');
    dirs.push(dataDir);
    const operatorToken = newToken();
    const b = await spawnBackend({ dataDir, providerUrl: simUrl.listening, credential, operatorToken });
    try {
      expect(b.listening, b.stderr()).toBe(true);
      const op = (method: string, path: string, body?: unknown) => http(b.url, method, path, { token: operatorToken, body });
      const c = (await op('POST', '/v1/operator/customers', { limits: { per_order_cents: 5000, monthly_cents: 9000 }, subscription: 'active' })).json;
      const created = await http(b.url, 'POST', '/v1/orders', { token: c.token, body: { kind: 'domain', item_id: 'sim-domain-com-1y', domain: 'by-hand.example' }, headers: { 'Idempotency-Key': 'by-hand-1' } });
      expect(created.json.order.summary).toBe('Waits for the operator\'s approval (quote $12.00 USD).');
      const approved = (await op('POST', `/v1/operator/orders/${created.json.order.order_id}/approve`)).json.order;
      expect(approved.summary).toBe('Done: the domain is ready; every step completed.');
      const overview = (await op('GET', '/v1/operator/overview')).json;
      expect(overview.provider).toMatchObject({ name: 'simulated provider', simulated: true });
      expect(overview.customers[0]).toMatchObject({ paid_this_month_cents: 1200, approved_this_month_cents: 1200 });
      expect(out).not.toContain(credential);
    } finally {
      b.child.kill('SIGTERM');
      await b.exited;
      sim.kill('SIGTERM');
      expect(await simExited).toBe(0);
    }
  }, 30_000);
});
