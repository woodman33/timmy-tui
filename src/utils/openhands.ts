import { execFileSync } from 'child_process';

// OpenHands adapter — runner, not control plane. Phase 1 is the CLI inside a
// jailed workspace; the Python SDK (sidecar speaking NDJSON) is phase 3 and
// only if phases 1–2 prove out. Headless mode auto-approves INSIDE its own
// loop, so the WORKSPACE is the boundary; receipts + approvals stay ours.

export interface OpenHandsStatus { installed: boolean; path?: string; version?: string; install: string }

export const OPENHANDS_INSTALL = 'uv tool install openhands --python 3.12';

export function detectOpenHands(): OpenHandsStatus {
  try {
    const path = execFileSync('sh', ['-c', 'command -v openhands'], { encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!path) return { installed: false, install: OPENHANDS_INSTALL };
    let version: string | undefined;
    try {
      // short probe: some openhands builds hang on --version (interactive boot)
      version = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* version flag varies or hangs — detection still stands */ }
    return { installed: true, path, version, install: OPENHANDS_INSTALL };
  } catch {
    return { installed: false, install: OPENHANDS_INSTALL };
  }
}

// Run markers let the TUI seal a receipt when a headless run finishes.
export const RUN_START = 'TIMMY_RUN_START';
export const RUN_END = 'TIMMY_RUN_END';

export function hasRunStart(lines: string[]): boolean {
  return lines.some(l => l.includes(RUN_START));
}

export function parseRunEnd(lines: string[]): { code: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/TIMMY_RUN_END:(\d+)/);
    if (m) return { code: Number(m[1]) };
  }
  return null;
}
