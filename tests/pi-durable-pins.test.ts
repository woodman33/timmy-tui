/**
 * Pi Durable S1 (R4 H118), plan i.10: the worker refuses to start on a version mismatch, saying which package and which
 * versions. REAL: the worker process (node --import tsx), its pin check, the supervisor; the pins file, the worker
 * package's manifest and lockfile. FAKE: the mismatching worker folders (temporary folders holding only package.json
 * files that claim other versions) and the fixture projects. No model is involved.
 *
 * The refusals need no installed packages (the check reads manifests before anything is loaded); the check against the
 * installed folder runs only when it is installed (the operator's yes).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { piPaths } from '../src/pi-durable/paths.js';
import { checkPins, PINS } from '../src/pi-durable/pins.js';
import { ensureWorker, workerCommand } from '../src/pi-durable/supervisor.js';
import { cleanup, INSTALLED, project, WORKER_DIR } from './helpers/pi-durable.js';

const fakes: string[] = [];
afterAll(() => { cleanup(); for (const f of fakes) rmSync(f, { recursive: true, force: true }); });

/** A FAKE worker folder: one package.json per named package, with the version given (null: not installed). */
function fakeWorkerDir(versions: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-durable-fake-worker-'));
  fakes.push(dir);
  for (const [name, version] of Object.entries(versions)) {
    if (version === null) continue;
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  return dir;
}

function runWorker(root: string, workerDir: string): Promise<{ code: number | null; stderr: string }> {
  const { command, args } = workerCommand();
  return new Promise((resolveRun) => {
    const child = spawn(command, [...args, '--project', root, '--worker-dir', workerDir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (code) => { clearTimeout(kill); resolveRun({ code, stderr }); });
  });
}

describe('the Pi worker\'s pins (plan i.10)', () => {
  it('the pins are exact and the same in pins.ts, the worker package and its lockfile', () => {
    expect(PINS).toEqual({ '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0', '@earendil-works/chord': '1.1.0' });
    const manifest = JSON.parse(readFileSync(join(WORKER_DIR, 'package.json'), 'utf8')) as { private?: boolean; dependencies: Record<string, string> };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual(PINS);
    const lock = JSON.parse(readFileSync(join(WORKER_DIR, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
    for (const [name, pin] of Object.entries(PINS)) expect(lock.packages[`node_modules/${name}`]?.version).toBe(pin);
    // the worker folder is not in Timmy's npm files
    const root = JSON.parse(readFileSync(join(WORKER_DIR, '..', '..', 'package.json'), 'utf8')) as { files: string[]; dependencies?: Record<string, string> };
    expect(root.files.some((f) => f.startsWith('workers/pi-durable'))).toBe(false);
    expect(Object.keys(root.dependencies ?? {}).filter((d) => d.startsWith('@earendil-works/'))).toEqual([]);
  });

  it.skipIf(!INSTALLED)('the installed worker folder matches its pins', () => {
    expect(checkPins(WORKER_DIR)).toEqual({ ok: true, versions: PINS });
  });

  it('a mismatch: the worker refuses to start (exit 4), naming each package and both versions, before it opens anything', async () => {
    const root = project('pins-mismatch');
    const dir = fakeWorkerDir({ '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.0.4', '@earendil-works/chord': null });
    const r = await runWorker(root, dir);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('the Pi worker refuses to start');
    expect(r.stderr).toContain('@earendil-works/pi-ai is 1.0.4 in the worker folder, pinned 1.1.0');
    expect(r.stderr).toContain('@earendil-works/chord is not installed in the worker folder (pinned 1.1.0)');
    expect(r.stderr).not.toContain('@earendil-works/pi-durable is');
    const p = piPaths(root);
    expect(existsSync(p.store)).toBe(false);
    expect(existsSync(p.owner)).toBe(false);
  });

  it('the supervisor reports the refusal with the worker\'s words (its log), and starts no second attempt that could succeed', async () => {
    const root = project('pins-supervisor');
    const dir = fakeWorkerDir({ '@earendil-works/pi-durable': '1.0.3', '@earendil-works/pi-ai': '1.1.0', '@earendil-works/chord': '1.1.0' });
    await expect(ensureWorker(root, { workerDir: dir, waitMs: 45_000 })).rejects.toThrow(/exited 4 before it answered[\s\S]*@earendil-works\/pi-durable is 1\.0\.3 in the worker folder, pinned 1\.1\.0/);
    expect(existsSync(piPaths(root).store)).toBe(false);
  });
});
