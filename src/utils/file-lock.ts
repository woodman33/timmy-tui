import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';

// v0.5 concurrency fix: serialize append-only files across processes with an
// atomic mkdir lock. Stale locks are only stolen when their holder PID is dead.
const LOCK_STALE_MS = 10000;

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export function withLockDir<T>(lock: string, fn: () => T): T {
  mkdirSync(dirname(lock), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let steal = false;
      try {
        const stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
        const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
        steal = stale && !pidAlive(pid);
      } catch { steal = false; }
      if (steal) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ } }
      if (Date.now() - t0 > 30000) throw new Error(`lock timeout (held by live writer): ${lock}`);
      spawnSync('sleep', ['0.05']);
    }
  }
  try { writeFileSync(join(lock, 'pid'), String(process.pid)); } catch { /* best-effort */ }
  try {
    return fn();
  } finally {
    try { unlinkSync(join(lock, 'pid')); } catch { /* best-effort */ }
    try { rmdirSync(lock); } catch { /* already released */ }
  }
}
