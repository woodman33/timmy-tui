import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpProService, type FetchLike } from '../src/pro/client.js';
import { ProServiceError } from '../src/pro/ports.js';
import { DAY, proWorld } from './helpers/pro-harness.js';

const UNKNOWN_KEY = 'tpro_00000000-00000000-00000000-00000000';
const servers: Server[] = [];

async function serviceError(promise: Promise<unknown>): Promise<ProServiceError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ProServiceError);
  return error as ProServiceError;
}

const answering = (status: number, body: string, contentType = 'application/json'): FetchLike =>
  async () => new Response(body, { status, headers: { 'content-type': contentType } });

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

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
    expect(await serviceError(service.activate(claimed.key))).toMatchObject({ kind: 'refused', code: 'unknown_key' });
    expect(await service.billingUrl()).toBe('https://billing.stripe.com/p/login/test_portal');
  });

  it('turns a coded refusal into kind refused with the code, status and server message', async () => {
    const world = await proWorld();
    const error = await serviceError(new HttpProService(world.origin, world.fetch).activate(UNKNOWN_KEY));
    expect(error).toMatchObject({ kind: 'refused', code: 'unknown_key', httpStatus: 404, message: 'unknown license key', retryable: false });
  });
});

describe('HttpProService details', () => {
  it('carries the subscription status the service reported with a refusal', async () => {
    const world = await proWorld();
    const service = new HttpProService(world.origin, world.fetch);
    const { sessionId } = await service.startCheckout();
    const sub = world.stripe.pay(sessionId);
    const claim = await service.claim(sessionId);
    if (claim.state !== 'ready') throw new Error('expected a ready claim');
    world.stripe.subs.set(sub.id, { ...sub, status: 'canceled' });
    await world.webhook({ id: 'evt_cancel', type: 'customer.subscription.deleted', data: { object: { id: sub.id } } });
    expect(await serviceError(service.activate(claim.key))).toMatchObject({ kind: 'refused', code: 'subscription_inactive', subscriptionStatus: 'canceled' });
  });

  it('reads a checkout that expired unpaid', async () => {
    const world = await proWorld();
    const service = new HttpProService(world.origin, world.fetch);
    const { sessionId } = await service.startCheckout();
    world.stripe.expire(sessionId);
    expect(await service.claim(sessionId)).toEqual({ state: 'expired' });
  });

  it('carries the subscription status behind a key the service can no longer show', async () => {
    const world = await proWorld();
    const service = new HttpProService(world.origin, world.fetch);
    const { sessionId } = await service.startCheckout();
    world.stripe.pay(sessionId);
    await service.claim(sessionId);
    world.advance(DAY + 1);
    expect(await serviceError(service.claim(sessionId))).toMatchObject({ kind: 'refused', code: 'key_already_issued', subscriptionStatus: 'active' });
  });

  it('only passes on https links, so a browser opener never sees another scheme', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://pay.example.com/x', 'not a url']) {
      const billing = await serviceError(new HttpProService('https://pro.example.com', answering(200, JSON.stringify({ url }))).billingUrl());
      expect(billing, url).toMatchObject({ kind: 'unexpected_response' });
      const checkout = await serviceError(new HttpProService('https://pro.example.com', answering(200, JSON.stringify({ url, session_id: 'cs_test_abc' }))).startCheckout());
      expect(checkout, url).toMatchObject({ kind: 'unexpected_response' });
    }
    expect(await new HttpProService('https://pro.example.com', answering(200, '{"url":"https://billing.stripe.com/p/x"}')).billingUrl()).toBe('https://billing.stripe.com/p/x');
    expect(await new HttpProService('http://127.0.0.1:8787', answering(200, '{"url":"http://127.0.0.1:8787/p"}')).billingUrl()).toBe('http://127.0.0.1:8787/p');
  });
});

describe('HttpProService failure kinds', () => {
  it('explains rate limiting and marks it retryable', async () => {
    const error = await serviceError(new HttpProService('https://pro.example.com', answering(429, '{"error":"too many requests","code":"rate_limited"}')).claim('cs_test_abc'));
    expect(error).toMatchObject({ kind: 'rate_limited', httpStatus: 429, retryable: true });
    expect(error.message).toContain('too many requests');
  });

  it('reports an unreachable service', async () => {
    const offline: FetchLike = async () => { throw new TypeError('fetch failed'); };
    const error = await serviceError(new HttpProService('https://pro.example.com', offline).billingUrl());
    expect(error).toMatchObject({ kind: 'unreachable', httpStatus: null, retryable: true, message: 'could not reach the Pro service' });
  });

  it('gives up when the service does not answer in time', async () => {
    const silent: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    const error = await serviceError(new HttpProService('https://pro.example.com', silent, 20).activate(UNKNOWN_KEY));
    expect(error).toMatchObject({ kind: 'unreachable', message: 'the Pro service did not answer in time' });
  });

  it('treats a coded 5xx as a server error worth retrying', async () => {
    const error = await serviceError(new HttpProService('https://pro.example.com', answering(503, '{"error":"service unavailable","code":"unavailable"}')).activate(UNKNOWN_KEY));
    expect(error).toMatchObject({ kind: 'server_error', code: 'unavailable', retryable: true });
  });

  it('never mistakes a proxy or a foreign host for a refusal', async () => {
    for (const [status, body, type] of [[403, '<html>Access denied</html>', 'text/html'], [404, '{"message":"no such route"}', 'application/json']] as const) {
      const error = await serviceError(new HttpProService('https://pro.example.com', answering(status, body, type)).activate(UNKNOWN_KEY));
      expect(error, `${status} ${type}`).toMatchObject({ kind: 'unexpected_response', code: null, httpStatus: status, retryable: true });
    }
  });

  it('rejects a malformed success body', async () => {
    for (const body of ['{}', 'not json', '{"status":"ready","key":7,"token":"x"}']) {
      const error = await serviceError(new HttpProService('https://pro.example.com', answering(200, body)).claim('cs_test_abc'));
      expect(error, body).toMatchObject({ kind: 'unexpected_response', message: 'unexpected response from the Pro service' });
    }
  });

  it('refuses to follow a redirect, so a key never leaves the configured origin', async () => {
    const elsewhere: string[] = [];
    const target = await listen((request, response) => { elsewhere.push(request.url ?? ''); response.end('{}'); });
    const origin = await listen((_request, response) => { response.writeHead(308, { location: `${target}/license/activate` }); response.end(); });
    const error = await serviceError(new HttpProService(origin).activate(UNKNOWN_KEY));
    expect(error).toMatchObject({ kind: 'unexpected_response', httpStatus: 308 });
    expect(error.message).toContain('redirect');
    expect(elsewhere).toEqual([]);
  });
});
