// CLI status-code unit contracts. Injected results are not inference evidence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVisionCli } from '../src/vision/cli.js';
import { getVisionStatus, runVisionInspection } from '../src/vision/runtime.js';

vi.mock('../src/vision/runtime.js', async orig => ({
  ...await orig<typeof import('../src/vision/runtime.js')>(),
  getVisionStatus: vi.fn(), runVisionInspection: vi.fn(),
  visionBridgeAvailability: () => ({ available: true, bridge: 'unit-fixture' }),
}));
let prior: typeof process.exitCode;
beforeEach(() => { prior = process.exitCode; process.exitCode = 0; vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { process.exitCode = prior; vi.restoreAllMocks(); });

describe('vision CLI does not report failures as successful exits', () => {
  it('configuration missing returns exit 2', async () => {
    vi.mocked(getVisionStatus).mockResolvedValue({ ok: false, state: 'not_configured' } as never);
    await runVisionCli(['status']);
    expect(process.exitCode).toBe(2);
  });
  it('model execution failure returns exit 1', async () => {
    vi.mocked(runVisionInspection).mockResolvedValue({ ok: false, state: 'execution_error' });
    await runVisionCli(['run', '--image', 'unit.png', '--model', 'unit/1']);
    expect(process.exitCode).toBe(1);
  });
  it('unsupported execution returns exit 2', async () => {
    vi.mocked(runVisionInspection).mockResolvedValue({ ok: false, state: 'not_available' });
    await runVisionCli(['run', '--image', 'unit.png', '--model', 'unit/1']);
    expect(process.exitCode).toBe(2);
  });
  it('successful execution returns exit 0', async () => {
    vi.mocked(runVisionInspection).mockResolvedValue({ ok: true, state: 'observed' });
    process.exitCode = 1;
    await runVisionCli(['run', '--image', 'unit.png', '--model', 'unit/1']);
    expect(process.exitCode).toBe(0);
  });
});
