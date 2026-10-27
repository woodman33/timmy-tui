import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OpenHandsAttemptStore, type AttemptScope } from '../src/utils/openhands-attempts.js';

const dirs: string[] = [];
const stores: OpenHandsAttemptStore[] = [];
const scope: AttemptScope = { principal: 'alice', project: 'p1', operation: 'edit-1', sourceRevision: 'rev-a' };
const result = (patch = 'actual patch bytes') => ({ ok: true, patch, workdir: '/isolated/work', planHash: 'plan-a' });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-oh-attempt-test-'));
  dirs.push(dir);
  const path = join(dir, 'attempts.sqlite');
  const store = new OpenHandsAttemptStore(path);
  stores.push(store);
  return { path, store };
}
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed for restart test */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('OpenHands durable publication authority', () => {
  it('retains staging metadata across restart before any completion without restarting work', () => {
    const { path, store } = fixture();
    const token = store.begin(scope);
    const staging = { workdir: '/isolated/recoverable-work', planHash: 'approved-plan' };
    store.stage(token, staging);
    store.stage(token, staging);
    expect(() => store.stage(token, { ...staging, planHash: 'changed' })).toThrow('Conflicting');
    store.close();
    const restarted = new OpenHandsAttemptStore(path); stores.push(restarted);
    expect(restarted.attempts(scope)[0]).toMatchObject({ ...token, status: 'running', staging });
    expect(restarted.attempts(scope)[0].result).toBeUndefined();
    expect(restarted.current(scope)).toBeNull();
    expect(() => restarted.complete(token, result())).toThrow('does not match staging');
    expect(restarted.attempts(scope)[0].result).toBeUndefined();
    restarted.cancel(token);
    expect(() => restarted.stage(token, staging)).toThrow('Only running');
    expect(() => restarted.stage({ ...token, principal: 'bob' }, staging)).toThrow('Unknown or mismatched');
  });

  it('retains a late superseded patch without replacing the winning result, across restart', () => {
    const { path, store } = fixture();
    const old = store.begin(scope), winner = store.begin(scope);
    const publication = store.complete(winner, result('winner'));
    expect(publication.status).toBe('committed');
    expect(publication.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    store.close();
    const restarted = new OpenHandsAttemptStore(path); stores.push(restarted);
    expect(restarted.complete(old, result('late')).status).toBe('superseded');
    expect(restarted.current(scope)?.result?.patch).toBe('winner');
    expect(restarted.attempts(scope).map(a => [a.status, a.result?.patch])).toEqual([
      ['superseded', 'late'], ['committed', 'winner']
    ]);
  });

  it('cancels before completion and retains the late result without promotion', () => {
    const { store } = fixture();
    const token = store.begin(scope);
    expect(store.cancel(token)).toBe(true);
    expect(store.cancel(token)).toBe(false);
    expect(store.complete(token, result()).status).toBe('cancelled');
    expect(store.current(scope)).toBeNull();
    expect(store.attempts(scope)[0].result).toEqual(result());
  });

  it('does not retroactively cancel committed output and preserves it on a failed retry', () => {
    const { store } = fixture();
    const first = store.begin(scope);
    store.complete(first, result('good'));
    expect(store.cancel(first)).toBe(false);
    expect(store.complete(store.begin(scope), { ...result('bad'), ok: false }).status).toBe('failed');
    expect(store.current(scope)?.result?.patch).toBe('good');
  });

  it('is idempotent only for identical completions, even after a newer attempt begins', () => {
    const { store } = fixture();
    const token = store.begin(scope);
    const publication = store.complete(token, result());
    store.begin(scope);
    expect(store.complete(token, result())).toEqual(publication);
    expect(() => store.complete(token, result('replacement'))).toThrow('Conflicting duplicate');
    expect(store.current(scope)?.result?.patch).toBe(result().patch);
  });

  it('rejects unknown, future, foreign-user, foreign-project and altered-revision tokens', () => {
    const { store } = fixture();
    const token = store.begin(scope);
    for (const altered of [
      { attemptId: 'invented' }, { generation: token.generation + 1 },
      { principal: 'bob' }, { project: 'p2' }, { sourceRevision: 'rev-b' }, { operation: 'edit-2' }
    ]) {
      expect(() => store.complete({ ...token, ...altered }, result())).toThrow('Unknown or mismatched');
      expect(() => store.cancel({ ...token, ...altered })).toThrow('Unknown or mismatched');
    }
    expect(store.attempts(scope)[0].status).toBe('running');
    expect(store.current(scope)).toBeNull();
  });

  it('fences older source revisions while isolating user and project heads', () => {
    const { store } = fixture();
    const old = store.begin(scope);
    const changed = { ...scope, sourceRevision: 'rev-b' };
    const fresh = store.begin(changed);
    expect(fresh.generation).toBe(2);
    expect(store.complete(old, result('old')).status).toBe('superseded');
    store.complete(fresh, result('fresh'));
    expect(store.current(scope)).toBeNull();
    expect(store.current(changed)?.result?.patch).toBe('fresh');
    for (const distinct of [{ ...scope, principal: 'bob' }, { ...scope, project: 'p2' }]) {
      expect(store.current(distinct)).toBeNull();
      const token = store.begin(distinct);
      expect(token.generation).toBe(1);
      store.complete(token, result('other'));
    }
    expect(store.current(changed)?.result?.patch).toBe('fresh');
  });

  it('serializes two independent SQLite connections and rejects stale publication', () => {
    const { path, store } = fixture();
    const other = new OpenHandsAttemptStore(path); stores.push(other);
    const a = store.begin(scope), b = other.begin(scope);
    expect([a.generation, b.generation]).toEqual([1, 2]);
    expect(store.complete(a, result('a')).status).toBe('superseded');
    expect(other.complete(b, result('b')).status).toBe('committed');
    expect(store.current(scope)?.attemptId).toBe(b.attemptId);
  });

  it('allocates distinct monotonic generations under concurrent process writers', async () => {
    const { path, store } = fixture();
    const modulePath = new URL('../src/utils/openhands-attempts.ts', import.meta.url).href;
    const script = `import { OpenHandsAttemptStore } from ${JSON.stringify(modulePath)};
      const store = new OpenHandsAttemptStore(process.argv[1]);
      const scope = JSON.parse(process.argv[2]);
      for (let i = 0; i < 15; i++) store.begin(scope);
      store.close();`;
    const run = promisify(execFile);
    await Promise.all([0, 1].map(() => run(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, path, JSON.stringify(scope)], { timeout: 20000 })));
    const attempts = store.attempts(scope);
    expect(attempts.map(a => a.generation)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(attempts.map(a => a.attemptId)).size).toBe(30);
    expect(attempts.filter(a => a.status === 'running')).toHaveLength(1);
    expect(store.complete(attempts[0], result('stale')).status).toBe('superseded');
    expect(store.complete(attempts[29], result('latest')).status).toBe('committed');
  }, 25000);

  it('rejects empty scope fields and non-durable storage', () => {
    const { store } = fixture();
    expect(() => store.begin({ ...scope, principal: '' })).toThrow('Missing attempt principal');
    expect(() => new OpenHandsAttemptStore(':memory:')).toThrow('durable');
  });
});
