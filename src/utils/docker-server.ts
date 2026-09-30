import { spawnSync } from 'child_process';

/** Read-only daemon probe. Older Docker clients can exit zero after an API error
 * when --format is used, so success also requires actual server version data. */
export function probeDockerServerVersion(timeoutMs = 2500): string | null {
  try {
    const result = spawnSync('docker', ['info', '--format', '{{json .ServerVersion}}'], {
      encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || result.error || result.signal) return null;
    const version: unknown = JSON.parse(result.stdout);
    return typeof version === 'string' && version.trim().length > 0
      && version.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(version) ? version.trim() : null;
  } catch { return null; }
}
