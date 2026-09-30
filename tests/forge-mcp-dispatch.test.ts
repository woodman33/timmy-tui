import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(), status: vi.fn(), approve: vi.fn(), receipt: vi.fn(),
}));
vi.mock('../src/forge/mcp-tools.js', () => ({
  forgeRun: mocks.run, forgeStatus: mocks.status, forgeApprove: mocks.approve,
}));
vi.mock('../src/utils/receipts.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/receipts.js')>(),
  appendReceipt: mocks.receipt,
}));
import { dispatchMcpTool } from '../src/mcp/server.js';

beforeEach(() => vi.resetAllMocks());

describe('forge MCP dispatch boundary', () => {
  it('preserves malformed argument types for the runtime validator', () => {
    const mission = ['mission'];
    const hash = ['a'.repeat(32)];
    dispatchMcpTool('timmy_forge_status', { mission_id: mission });
    dispatchMcpTool('timmy_forge_approve', { planHash: hash });
    expect(mocks.status).toHaveBeenCalledWith(mission);
    expect(mocks.approve).toHaveBeenCalledWith(hash);
  });

  it('does not expose exception text in the result or error receipt', () => {
    const privateDetail = 'private-detail-that-must-stay-out-of-tool-results';
    mocks.run.mockImplementation(() => { throw new Error(privateDetail); });
    const result = dispatchMcpTool('timmy_forge_run', { brief: {} });
    expect(result).toEqual({ ok: false, error_class: 'internal', error: 'forge internal error' });
    expect(JSON.stringify(mocks.receipt.mock.calls)).not.toContain(privateDetail);
    expect(mocks.receipt).toHaveBeenCalledOnce();
  });

  it('still returns a safe refusal when the error receipt cannot be written', () => {
    mocks.status.mockImplementation(() => { throw new Error('private source failure'); });
    mocks.receipt.mockImplementation(() => { throw new Error('private receipt failure'); });
    expect(dispatchMcpTool('timmy_forge_status', { mission_id: 'mission' })).toEqual({
      ok: false, error_class: 'internal', error: 'forge internal error',
    });
  });
});
