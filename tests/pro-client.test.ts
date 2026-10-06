import { describe, expect, it } from 'vitest';
import { HttpProService, ProServiceError, type FetchLike } from '../src/pro/client.js';
import { proWorld } from './helpers/pro-harness.js';

const UNKNOWN_KEY = 'tpro_00000000-00000000-00000000-00000000';

async function serviceError(promise: Promise<unknown>): Promise<ProServiceError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ProServiceError);
  return error as ProServiceError;
}

const answering = (status: number, body: string): FetchLike => async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });

describe('HttpProService against the real handler', () => {
  it('checks out, waits, then claims a key and token', async () => {
    const world = await proWorld();
    const service = new HttpProService(world.origin, world.fetch);
    const checkout = await service.startCheckout();
    expect(checkout.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(world.stripe.calls.some((call) => call.startsWith('create:price_test_pro:cli:'))).toBe(true);

    expect(await service.claim(checkout.sessionId)).toEqual({ state: 'pending' });
    world.stripe.pay(checkout.sessionId);
    const ready = await service.claim(checkout.sessionId);
    expect(ready.state).toBe('ready');
    if (ready.state !== 'ready') return;
    expect(ready.key).toMatch(/^tpro_[0-9A-Z]{8}-[0-9A-Z]{8}-[0-9A-Z]{8}-[0-9A-Z]{8}$/);
    expect(ready.token.split('.')[0]).toBe('tpro1');
  });

  it('activates, rotates and fetches the billing link', async () => {
    const world = await proWorld();
    const service = new HttpProService(world.origin, world.fetch);
    const { sessionId } = await service.startCheckout();
    world.stripe.pay(sessionId);
    const claimed = await service.claim(sessionId);
    if (claimed.state !== 'ready') throw new Error('expected a ready claim');

    expect((await service.activate(claimed.key)).token.split('.')[0]).toBe('tpro1');
    const { key: rotated } = await service.rotate(claimed.key);
    expect(rotated).not.toBe(claimed.key);
    expect((await serviceError(service.activate(claimed.key))).status).toBe(404);
    expect(await service.billingUrl()).toBe('https://billing.stripe.com/p/login/test_portal');
  });

  it("maps server errors to ProServiceError with the server's message", async () => {
    const world = await proWorld();
    const error = await serviceError(new HttpProService(world.origin, world.fetch).activate(UNKNOWN_KEY));
    expect(error.status).toBe(404);
    expect(error.message).toBe('unknown license key');
  });
});

describe('HttpProService failure handling', () => {
  it('explains rate limiting', async () => {
    const error = await serviceError(new HttpProService('https://pro.example.com', answering(429, '{"error":"rate limited"}')).claim('cs_test_abc'));
    expect(error.status).toBe(429);
    expect(error.message).toContain('too many requests');
  });

  it('reports an unreachable service as status 0', async () => {
    const offline: FetchLike = async () => { throw new TypeError('fetch failed'); };
    const error = await serviceError(new HttpProService('https://pro.example.com', offline).billingUrl());
    expect(error.status).toBe(0);
    expect(error.message).toBe('could not reach the Pro service');
  });

  it('gives up when the service does not answer in time', async () => {
    const silent: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    const error = await serviceError(new HttpProService('https://pro.example.com', silent, 20).activate(UNKNOWN_KEY));
    expect(error.status).toBe(0);
    expect(error.message).toBe('the Pro service did not answer in time');
  });

  it('rejects a malformed success body', async () => {
    for (const body of ['{}', 'not json', '{"status":"ready","key":7,"token":"x"}']) {
      const error = await serviceError(new HttpProService('https://pro.example.com', answering(200, body)).claim('cs_test_abc'));
      expect(error.message, body).toBe('unexpected response from the Pro service');
    }
  });
});
