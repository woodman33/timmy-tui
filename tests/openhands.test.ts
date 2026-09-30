import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());
import { detectOpenHands, hasRunStart, parseRunEnd, RUN_START } from '../src/utils/openhands.js';

describe('openhands adapter', () => {
  it('parses run-end markers with exit codes', () => {
    expect(parseRunEnd(['noise', 'TIMMY_RUN_END:0'])).toEqual({ code: 0 });
    expect(parseRunEnd(['TIMMY_RUN_END:3', 'prompt>'])).toEqual({ code: 3 });
    expect(parseRunEnd(['no markers here'])).toBeNull();
  });

  it('detects start markers', () => {
    expect(hasRunStart([RUN_START, 'openhands thinking…'])).toBe(true);
    expect(hasRunStart(['openhands thinking…'])).toBe(false);
  });

  it('reports missing installation without executing a runner', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('not found'); });
    expect(detectOpenHands()).toEqual({ installed: false, install: 'uv tool install openhands --python 3.12' });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('probes the resolved binary with bounded lookup and version commands', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('/tools/openhands\n').mockReturnValueOnce('openhands 1.0\n');
    expect(detectOpenHands()).toEqual({ installed: true, path: '/tools/openhands', version: 'openhands 1.0', install: 'uv tool install openhands --python 3.12' });
    const bounded = expect.objectContaining({ timeout: 1500, killSignal: 'SIGKILL' });
    expect(execFileSync).toHaveBeenNthCalledWith(1, 'sh', ['-c', 'command -v openhands'], bounded);
    expect(execFileSync).toHaveBeenNthCalledWith(2, '/tools/openhands', ['--version'], bounded);
  });

  it('keeps installed status when the version probe fails or times out', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('/tools/openhands');
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('ETIMEDOUT'); });
    expect(detectOpenHands()).toEqual({ installed: true, path: '/tools/openhands', version: undefined, install: 'uv tool install openhands --python 3.12' });
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty binary lookup without invoking a version probe', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('\n');
    expect(detectOpenHands().installed).toBe(false);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
