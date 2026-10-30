import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'child_process';
import { OpenHandsAttemptStore, type AttemptScope, type AttemptToken } from '../src/utils/openhands-attempts.js';
import { openHandsAttemptPath, runOpenHandsTask } from '../src/utils/openhands-adapter.js';

vi.mock('child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('../src/utils/receipts.js', () => ({ appendReceipt: vi.fn(() => ({ hash: 'test-receipt' })) }));
vi.mock('../src/bus/index.js', () => ({ publish: vi.fn() }));

class WorkerProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  exitCode: number | null = null;
  kill = vi.fn(() => true);
  constructor(readonly workdir: string) { super(); }
}

const scope: AttemptScope = { principal: 'verified-user', project: 'project-1', operation: 'edit-1', sourceRevision: 'source-a' };
let home: string;
let revision: string;
const workers: WorkerProcess[] = [];
const temporaryWorkspaces = new Set<string>();
const patches = new Map<string, string>();

function opts() {
  return { dir: home, task: 'repair the selected source', fixture_repo: '/fixture/source', acceptance: ['node test.js'],
    engine: 'docker' as const, preApproved: { plan_hash: 'test-supervisor-arm' } };
}
function complete(worker: WorkerProcess, patch: string, exit = 0, override: Record<string, unknown> = {}) {
  patches.set(worker.workdir, patch);
  const checks = [{ cmd: 'node test.js', code: 0 }];
  worker.stdout.emit('data', JSON.stringify({ ok: true, host_canary: false, patch, patch_applied: true,
    work_acceptance: checks, pristine_acceptance: checks, ...override }) + '\n');
  worker.exitCode = exit;
  worker.emit('close', exit);
}
function inspect<T>(read: (store: OpenHandsAttemptStore) => T): T {
  const store = new OpenHandsAttemptStore(openHandsAttemptPath(home));
  try { return read(store); } finally { store.close(); }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'timmy-oh-lifecycle-'));
  revision = 'source-a';
  vi.mocked(spawnSync).mockImplementation(((command: string, args: string[], options?: { cwd?: string }) => {
    let stdout = '';
    if (command === 'git' && args[0] === 'clone') temporaryWorkspaces.add(args.at(-1)!);
    else if (command === 'git' && args[0] === 'rev-parse') stdout = revision + '\n';
    else if (command === 'git' && args[0] === 'diff') stdout = patches.get(options?.cwd ?? '') ?? '';
    else if (command !== 'docker') throw new Error(`Unexpected host command: ${command}`);
    return { status: 0, stdout, stderr: '', pid: 0, output: [], signal: null };
  }) as typeof spawnSync);
  vi.mocked(spawn).mockImplementation(((command: string, _args: string[], options: { cwd: string }) => {
    expect(command).toBe('docker');
    const worker = new WorkerProcess(options.cwd);
    workers.push(worker);
    return worker;
  }) as unknown as typeof spawn);
});
afterEach(() => {
  for (const worker of workers.splice(0)) worker.emit('close', 1);
  for (const path of temporaryWorkspaces) rmSync(path, { recursive: true, force: true });
  temporaryWorkspaces.clear(); patches.clear();
  rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('OpenHands adapter with durable controller (process boundary mocked, SQLite real)', () => {
  it('publishes checked Docker output without running acceptance shell commands on the host', async () => {
    const run = runOpenHandsTask(opts(), { scope });
    expect(workers).toHaveLength(1);
    complete(workers[0], 'checked patch');
    const result = await run;
    expect(result.ok).toBe(true);
    expect(result.publication).toBe('committed');
    expect(result.attempt?.sourceRevision).toBe('source-a');
    expect(inspect(s => s.current(scope)?.result?.patch)).toBe('checked patch');
    expect(vi.mocked(spawnSync).mock.calls.some(([command]) => command === 'bash')).toBe(false);
    const docker = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(docker.filter(arg => arg.includes(':/work'))).toEqual([`${workers[0].workdir}:/work`]);
    expect(docker.some(arg => arg.includes(openHandsAttemptPath(home)))).toBe(false);
  });

  it('retains a late result from an older source revision while only the new revision publishes', async () => {
    const oldRun = runOpenHandsTask(opts(), { scope });
    revision = 'source-b';
    const freshScope = { ...scope, sourceRevision: revision };
    const newRun = runOpenHandsTask(opts(), { scope: freshScope });
    complete(workers[1], 'new patch');
    expect((await newRun).publication).toBe('committed');
    complete(workers[0], 'late old patch');
    const old = await oldRun;
    expect(old.ok).toBe(false);
    expect(old.publication).toBe('superseded');
    expect(inspect(s => s.current(freshScope)?.result?.patch)).toBe('new patch');
    expect(inspect(s => s.attempts(scope)[0].result?.patch)).toBe('late old patch');
    expect(inspect(s => s.current(scope))).toBeNull();
  });

  it('revokes publication before requesting termination and retains output arriving after abort', async () => {
    const abort = new AbortController();
    let token: AttemptToken | undefined;
    const run = runOpenHandsTask(opts(), { scope, signal: abort.signal, onAttempt: a => { token = a; } });
    workers[0].kill.mockImplementation(() => {
      expect(inspect(s => s.attempts(scope)[0].status)).toBe('cancelled');
      return true;
    });
    abort.abort();
    expect(workers[0].kill).toHaveBeenCalledOnce();
    complete(workers[0], 'output after cancel');
    const result = await run;
    expect(result.attempt).toEqual(token);
    expect(result.publication).toBe('cancelled');
    expect(result.ok).toBe(false);
    expect(inspect(s => s.current(scope))).toBeNull();
    expect(inspect(s => s.attempts(scope)[0].result?.patch)).toBe('output after cancel');
  });

  it('cannot commit a nonzero worker exit despite a green bridge envelope', async () => {
    const run = runOpenHandsTask(opts(), { scope });
    complete(workers[0], 'untrusted success claim', 7);
    const result = await run;
    expect(result.ok).toBe(false);
    expect(result.publication).toBe('failed');
    expect(inspect(s => s.current(scope))).toBeNull();
  });

  it('resolves a spawn error as a retained failed attempt without waiting for exit', async () => {
    const run = runOpenHandsTask(opts(), { scope });
    workers[0].emit('error', new Error('spawn ENOENT'));
    const result = await run;
    expect(result.ok).toBe(false);
    expect(result.publication).toBe('failed');
    expect(result.note).toContain('spawn ENOENT');
    expect(inspect(s => s.attempts(scope)[0].status)).toBe('failed');
  });

  it('fails closed when the worker claims different acceptance commands', async () => {
    const run = runOpenHandsTask(opts(), { scope });
    complete(workers[0], 'patch', 0, { work_acceptance: [{ cmd: 'true', code: 0 }] });
    expect((await run).publication).toBe('failed');
    expect(inspect(s => s.current(scope))).toBeNull();
  });
});
