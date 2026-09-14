import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { consumeApproval } from '../src/utils/approvals.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { auditProviders } from '../src/agent/provider-registry.js';
import { resolveFalCredential } from '../src/utils/fal-credentials.js';
import { buildFal3dPlan, checkFal3dCredentials, collectFal3d, fal3dPayload, readFal3dState, submitFal3dPlan } from '../src/utils/fal3d-adapter.js';

// Isolated local fixtures only: never mint an operator token, sign a real
// receipt, call a provider, or load the user's environment into a request.
vi.mock('../src/utils/approvals.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/approvals.js')>(),
  consumeApproval: vi.fn(),
}));
vi.mock('../src/utils/receipts.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/receipts.js')>(),
  appendReceipt: vi.fn(() => ({ hash: 'fixture-receipt' })),
}));

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YQAAAABJRU5ErkJggg==', 'base64');
let dir: string;
let env: NodeJS.ProcessEnv;
const spec = () => ({ schema: 'timmy-fal3d/v1', project: 'anomaly-close-environment', max_spend_usd: 3,
  jobs: [{ id: 'hero_dead_tree', model: 'h3.1', image: 'reference.png' },
    { id: 'debris', model: 'p1', image: 'reference.png' },
    { id: 'rock', model: 'trellis2', image: 'reference.png' }] });
const handle = (id: string) => ({ request_id: id,
  status_url: `https://queue.fal.run/tripo3d/h3.1/requests/${id}/status`,
  response_url: `https://queue.fal.run/tripo3d/h3.1/requests/${id}` });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-fal3d-'));
  writeFileSync(join(dir, 'reference.png'), image);
  env = { FALAI_API_KEY: randomBytes(24).toString('hex') };
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  vi.mocked(consumeApproval).mockReset().mockReturnValue({ ok: false, note: 'operator token required' });
  vi.mocked(appendReceipt).mockClear();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected network request'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe('fal credential compatibility', () => {
  it('accepts the existing alias, prefers canonical nonblank key, and prints only names', () => {
    expect(resolveFalCredential(env)?.source).toBe('FALAI_API_KEY');
    const canonical = randomBytes(24).toString('hex');
    expect(resolveFalCredential({ ...env, FAL_KEY: canonical })?.key).toBe(canonical);
    expect(resolveFalCredential({ ...env, FAL_KEY: '   ' })?.source).toBe('FALAI_API_KEY');
    const audit = auditProviders(env).find(p => p.id === 'fal');
    expect(audit).toMatchObject({ enabled: true, readiness: 'ready', missingRequiredEnvVars: [], presentEnvVars: ['FALAI_API_KEY'] });
    expect(JSON.stringify(audit)).not.toContain(env.FALAI_API_KEY);
    expect(resolveFalCredential({ FAL_KEY: '   ' })).toBeUndefined();
  });

  it('separates configured from authenticated using only the documented pricing GET', async () => {
    expect(await checkFal3dCredentials(env)).toMatchObject({ configured: true, auth_status: 'not_checked', generation_submitted: false });
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(json({ prices: [] }));
    const result = await checkFal3dCredentials(env, true);
    expect(result.auth_status).toBe('valid_for_pricing_read');
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('https://api.fal.ai/v1/models/pricing?');
    expect(options?.method).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(env.FALAI_API_KEY);
    vi.mocked(fetch).mockResolvedValue(json({}, 401));
    expect((await checkFal3dCredentials(env, true)).auth_status).toBe('invalid');
  });
});

describe('reference-bound offline plans', () => {
  it('pins three exact models, realistic option costs and actual image bytes without networking', () => {
    const plan = buildFal3dPlan(spec(), dir);
    expect(plan.estimated_cost_usd).toBe(1.4);
    expect(plan.jobs.map(j => j.endpoint)).toEqual(['tripo3d/h3.1/image-to-3d', 'tripo3d/p1/image-to-3d', 'fal-ai/trellis-2']);
    expect(plan).toEqual(buildFal3dPlan(spec(), dir));
    expect(JSON.stringify(plan)).not.toContain('base64');
    for (const job of plan.jobs) {
      const payload = fal3dPayload(job, dir);
      expect(payload.image_url).toBe(`data:image/png;base64,${image.toString('base64')}`);
      expect(payload).not.toHaveProperty('prompt');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects missing images, extraneous provider fields and over-budget batches', () => {
    expect(() => buildFal3dPlan({ ...spec(), max_spend_usd: 0.1 }, dir)).toThrow('exceeds');
    expect(() => buildFal3dPlan({ ...spec(), jobs: [{ id: 'hero', model: 'p1', image: 'missing.png' }] }, dir)).toThrow();
    expect(() => buildFal3dPlan({ ...spec(), jobs: [{ id: 'hero', model: 'p1', image: 'reference.png', options: { image_url: 'unapproved' } }] }, dir)).toThrow();
    expect(() => buildFal3dPlan({ ...spec(), jobs: [{ id: 'hero', model: 'h3.1', image: 'reference.png', options: { quad: true } }] }, dir)).toThrow();
  });
});

describe('paid queue boundary and recovery', () => {
  it('denies missing operator approval before any HTTP request', async () => {
    const plan = buildFal3dPlan(spec(), dir);
    await expect(submitFal3dPlan(plan, '', env, dir)).rejects.toThrow('operator token');
    expect(consumeApproval).toHaveBeenCalledWith('', plan.plan_hash);
    expect(fetch).not.toHaveBeenCalled();
    expect(appendReceipt).toHaveBeenCalledWith('runs', expect.objectContaining({ status: 'denied', plan_hash: plan.plan_hash }), dir);
  });

  it('rejects reference drift and edited costs before consuming an approval', async () => {
    const plan = buildFal3dPlan(spec(), dir);
    await expect(submitFal3dPlan({ ...plan, estimated_cost_usd: 0.01 }, '', env, dir)).rejects.toThrow('changed');
    writeFileSync(join(dir, 'reference.png'), Buffer.concat([image, Buffer.from('changed')]));
    await expect(submitFal3dPlan(plan, '', env, dir)).rejects.toThrow('changed');
    expect(consumeApproval).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('submits image bytes once, saves handles, and refuses a duplicate plan', async () => {
    const plan = buildFal3dPlan(spec(), dir);
    vi.mocked(consumeApproval).mockReturnValue({ ok: true });
    vi.mocked(fetch).mockImplementation(async () => json(handle(`fixture-${vi.mocked(fetch).mock.calls.length}`)));
    const state = await submitFal3dPlan(plan, 'mock-only', env, dir);
    expect(state.jobs.every(j => j.state === 'queued')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, options] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/queue\.fal\.run\//);
      expect(options?.method).toBe('POST');
      expect(options?.headers).toMatchObject({ 'X-Fal-No-Retry': '1', Authorization: `Key ${env.FALAI_API_KEY}` });
      expect(JSON.parse(String(options?.body)).image_url).toBe(`data:image/png;base64,${image.toString('base64')}`);
    }
    const saved = readFileSync(join(dir, '.timmy/fal3d', plan.plan_hash, 'state.json'), 'utf8');
    expect(saved).not.toContain(env.FALAI_API_KEY); expect(saved).not.toContain('base64');
    await expect(submitFal3dPlan(plan, 'mock-only', env, dir)).rejects.toThrow('already');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops the batch on an uncertain POST without retrying or billing the rest', async () => {
    vi.mocked(consumeApproval).mockReturnValue({ ok: true });
    vi.mocked(fetch).mockRejectedValue(new Error('timeout'));
    const state = await submitFal3dPlan(buildFal3dPlan(spec(), dir), 'mock-only', env, dir);
    expect(state.jobs.map(j => j.state)).toEqual(['uncertain', 'not_submitted', 'not_submitted']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('collects a complete GLB using GET only and never sends the key to CDN downloads', async () => {
    const input = { ...spec(), jobs: spec().jobs.slice(0, 1) };
    const plan = buildFal3dPlan(input, dir);
    vi.mocked(consumeApproval).mockReturnValue({ ok: true });
    vi.mocked(fetch).mockResolvedValue(json(handle('fixture-one')));
    await submitFal3dPlan(plan, 'mock-only', env, dir);
    vi.mocked(fetch).mockReset();
    const bytes = Buffer.alloc(20); bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
    vi.mocked(fetch).mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ model_mesh: { url: 'https://v3.fal.media/fixture.glb' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    const state = await collectFal3d(plan.plan_hash, env, dir);
    expect(state.jobs[0].state).toBe('complete');
    expect(readFileSync(join(dir, state.jobs[0].artifact!))).toEqual(bytes);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
    expect(vi.mocked(fetch).mock.calls[2][1]?.headers).toBeUndefined();
    expect(readFal3dState(plan.plan_hash, dir).jobs[0].sha256).toBeTruthy();
    vi.mocked(fetch).mockClear(); await collectFal3d(plan.plan_hash, env, dir); expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects credential forwarding outside the fal queue origin', async () => {
    vi.mocked(consumeApproval).mockReturnValue({ ok: true });
    vi.mocked(fetch).mockResolvedValue(json({ ...handle('fixture-one'), status_url: 'https://example.com/requests/fixture-one/status' }));
    const state = await submitFal3dPlan(buildFal3dPlan(spec(), dir), 'mock-only', env, dir);
    expect(state.jobs[0].state).toBe('uncertain');
    expect(state.jobs[0].request_id).toBe('fixture-one');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
