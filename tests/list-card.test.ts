import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listCardTool } from '../src/agent/tools.js';

describe('listCardTool tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('throws a clear error if API_BASE_URL is missing', async () => {
    delete process.env.BREAK_MODE_API_BASE_URL;
    delete process.env.API_BASE_URL;

    await expect(
      listCardTool.function.execute({ username: 'test-user' })
    ).rejects.toThrow('API_BASE_URL is REQUIRED');
  });

  it('throws a clear error if username is missing', async () => {
    process.env.API_BASE_URL = 'https://mock-engine.example.com';
    delete process.env.TIMMY_USERNAME;

    await expect(
      listCardTool.function.execute({})
    ).rejects.toThrow('Username is required');
  });

  it('resolves username from env if argument is omitted', async () => {
    process.env.API_BASE_URL = 'https://mock-engine.example.com';
    process.env.TIMMY_USERNAME = 'env-user';

    const mockFetch = vi.mocked(global.fetch);

    // GET /api/live/env-user
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        cardId: 'card-123',
        name: 'Black Lotus',
        confidence: 0.94,
        price: 346,
        pricingSource: 'live',
      }),
    } as Response);

    // POST /api/list
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        checkoutLink: 'https://checkout.stripe.com/mock',
        buyLink: 'https://buy.stripe.com/mock',
        listReceiptId: 'receipt-789',
      }),
    } as Response);

    const result = await listCardTool.function.execute({});

    expect(mockFetch.mock.calls[0][0]).toBe('https://mock-engine.example.com/api/live/env-user');
    expect(result.success).toBe(true);
  });

  it('resolves cardId from /api/live/{username} and returns success details on 200 POST', async () => {
    process.env.API_BASE_URL = 'https://mock-engine.example.com';
    
    const mockFetch = vi.mocked(global.fetch);

    // First fetch: GET /api/live/test-user
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        cardId: 'card-123',
        name: 'Black Lotus',
        confidence: 0.94,
        price: 346,
        pricingSource: 'live',
      }),
    } as Response);

    // Second fetch: POST /api/list
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        checkoutLink: 'https://checkout.stripe.com/mock',
        buyLink: 'https://buy.stripe.com/mock',
        listReceiptId: 'receipt-789',
      }),
    } as Response);

    const result = await listCardTool.function.execute({ username: 'test-user' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      success: true,
      checkoutLink: 'https://checkout.stripe.com/mock',
      buyLink: 'https://buy.stripe.com/mock',
      listReceiptId: 'receipt-789',
      confidence: 0.94,
      message: '94% confident, FMV $346 for Black Lotus — listing now.\nCheckout: https://checkout.stripe.com/mock\nBuy: https://buy.stripe.com/mock\nReceipt: receipt-789\npushed live to overlay',
    });
  });

  it('reports low confidence on 409 status code and does not retry', async () => {
    process.env.BREAK_MODE_API_BASE_URL = 'https://mock-engine.example.com/';
    const mockFetch = vi.mocked(global.fetch);

    // First fetch: GET /api/live/test-user
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        cardId: 'card-abc',
        name: 'Underground Sea',
        confidence: 0.71,
        price: 500,
        pricingSource: 'live',
      }),
    } as Response);

    // Second fetch: POST /api/list -> 409 Conflict
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
    } as Response);

    const result = await listCardTool.function.execute({ username: 'test-user', askPrice: 450 });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      success: false,
      confidence: 0.71,
      message: '✕ Card needs confirmation. Confidence is only 71%. Do NOT retry-force it.',
    });
  });

  it('refuses to list if pricingSource is not live', async () => {
    process.env.API_BASE_URL = 'https://mock-engine.example.com';
    const mockFetch = vi.mocked(global.fetch);

    // GET /api/live/test-user -> pricingSource: mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        cardId: 'card-123',
        name: 'Black Lotus',
        confidence: 0.94,
        price: 346,
        pricingSource: 'mock',
      }),
    } as Response);

    const result = await listCardTool.function.execute({ username: 'test-user' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: false,
      message: 'pricing not live — refusing to list',
    });
  });

  it('handles network/unreachable error gracefully', async () => {
    process.env.API_BASE_URL = 'https://mock-engine.example.com';
    const mockFetch = vi.mocked(global.fetch);

    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await listCardTool.function.execute({ username: 'test-user' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('✕ Network/unreachable error fetching live card');
  });

  const runLive = process.env.RUN_LIVE_INTEGRATION === '1';
  const itLive = runLive ? it : it.skip;

  itLive('real live Worker integration: Sol Ring lists successfully, charizard refuses', async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    const baseUrl = 'https://break-mode-engine.example.com';
    process.env.BREAK_MODE_API_BASE_URL = baseUrl;

    // 1. Scan Sol Ring to live state
    await fetch(`${baseUrl}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Sol Ring', cardQuery: 'Sol Ring' }),
    });

    // 2. Scan charizard to live state
    await fetch(`${baseUrl}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'charizard', cardQuery: 'charizard' }),
    });

    // 3. Execute Sol Ring tool call (positive case)
    const solResult = await listCardTool.function.execute({ username: 'Sol Ring' });
    console.log('--- Real Sol Ring Live Worker Output ---');
    console.log(JSON.stringify(solResult, null, 2));

    expect(solResult.success).toBe(true);
    expect(solResult.checkoutLink).toBeDefined();
    expect(solResult.buyLink).toBeDefined();
    expect(solResult.listReceiptId).toBeDefined();

    // 4. Execute charizard tool call (negative case)
    const charizardResult = await listCardTool.function.execute({ username: 'charizard' });
    console.log('--- Real Charizard Live Worker Output ---');
    console.log(JSON.stringify(charizardResult, null, 2));

    expect(charizardResult.success).toBe(false);
    expect(charizardResult.message).toBe('pricing not live — refusing to list');
  });
});
