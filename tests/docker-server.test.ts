import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ spawnSync: vi.fn() }));
import { spawnSync } from 'child_process';
import { probeDockerServerVersion } from '../src/utils/docker-server.js';
import { checkDocker } from '../src/utils/doctor.js';

function response(stdout: string, extra: Record<string, unknown> = {}) {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout, stderr: '', signal: null, ...extra } as ReturnType<typeof spawnSync>);
}
beforeEach(() => vi.mocked(spawnSync).mockReset());

describe('Docker daemon availability', () => {
  it('requires a server version and preserves the bounded shell probe', () => {
    response('"29.4.0"\n');
    expect(probeDockerServerVersion()).toBe('29.4.0');
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('docker', ['info', '--format', '{{json .ServerVersion}}'], {
      encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  it.each(['', 'ok\n', '""\n', '"   "', 'null', '{}', '[]', '123', '"unterminated', '"bad\\nversion"',
    '"bad\\u009bversion"', JSON.stringify('v'.repeat(129))])
  ('refuses successful CLI exit without valid server data: %j', stdout => {
    response(stdout);
    expect(probeDockerServerVersion()).toBeNull();
    expect(checkDocker()).toMatchObject({ name: 'docker daemon', required: true, state: 'not_configured' });
  });

  it.each([
    { status: 1 }, { status: null, signal: 'SIGKILL' },
    { error: Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }) },
    { error: Object.assign(new Error('Not installed'), { code: 'ENOENT' }) },
  ])('refuses failed or timed-out processes even with version-like output: %j', extra => {
    response('"29.4.0"', extra);
    expect(probeDockerServerVersion()).toBeNull();
  });

  it('refuses a thrown process failure', () => {
    response('', { status: 1 });
    vi.mocked(spawnSync).mockImplementationOnce(() => { throw new Error('Cannot spawn'); });
    expect(probeDockerServerVersion()).toBeNull();
  });

  it('preserves the doctor result shape and its existing five-second deadline', () => {
    response('"28.0.0-rc.1"\n');
    expect(checkDocker()).toEqual({ name: 'docker daemon', required: true, state: 'ok', note: 'v28.0.0-rc.1' });
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('docker', ['info', '--format', '{{json .ServerVersion}}'], {
      encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });
});
