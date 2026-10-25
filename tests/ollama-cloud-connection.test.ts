/**
 * R10 (H169; the lead's decision of 2026-10-22 18:02, on H170's proposal): Ollama Cloud as a connection of its own
 * (src/contracts/workspace.ts ConnectionId 'ollama-cloud'): its row in the workspace frame (src/ops/workspace-frame.ts), and
 * its check in `timmy workspace check` (checkConnections). Remote inference, labelled cloud, refused by local-only; set up by
 * the key the setup keeps (H170's keyInUse), observed only by a check that asked with that key. FAKE only: FAKE keys, and a
 * FAKE list in place of ollama.com; nothing leaves the process.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceConnection } from '../src/contracts/workspace.js';
import { buildWorkspaceFrame, checkConnections, CONNECTIONS_SCHEMA, connectionsPath, LIVE_FOR_MS, readConnections, writeConnections, type ConnectionCheck } from '../src/ops/workspace-frame.js';
import { keyFingerprint } from '../src/setup/provider-keys.js';

const KEY = 'FAKE-ollama-cloud-key-h169-0001';
const OTHER = 'FAKE-ollama-cloud-key-h169-0002';
const NOW = Date.parse('2026-10-22T19:00:00.000Z');

let home = '';
let project = '';
let env: Record<string, string | undefined> = {};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'h169-cloud-conn-'));
  project = join(home, 'proj');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, 'timmy'), { recursive: true });
  env = { HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_SETTINGS_DIR: join(home, 'settings'), PATH: process.env.PATH };
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** The key as the setup saves it (src/setup/provider-keys.ts saveKey's field), 0600. */
const keep = (key: string): void => writeFileSync(join(home, 'timmy', 'providers.json'), `${JSON.stringify({ ollama_cloud_api_key: key }, null, 1)}\n`, { mode: 0o600 });
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const observed = (c: ConnectionCheck): void => { writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { 'ollama-cloud': c } }, env); };
const row = async (): Promise<WorkspaceConnection> => (await buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => [], onPath: () => null, now: NOW })).connections.find((c) => c.id === 'ollama-cloud')!;

describe('Ollama Cloud\'s row in the frame', () => {
  it('with no key: not set up (optional), its step in words, remote inference said, and an old observation counts for nothing', async () => {
    const r = await row();
    expect(r).toMatchObject({
      label: 'Ollama Cloud (cloud models, optional)', state: 'not set up', observedAt: null, setup: null,
      words: 'optional: an Ollama API key from ollama.com/settings/keys, as OLLAMA_API_KEY or saved by the setup in providers.json; remote inference, nothing to download',
      detail: 'remote inference on ollama.com (cloud, no local weights); local-only refuses it; no price per request is known here, so free-only refuses it too',
    });
    // a check made with a key since removed: no key now, so nothing is observed of this setup
    observed({ answer: 'accepted', at: ago(60_000), detail: 'it lists 3 models; none was run', asked: keyFingerprint(KEY) });
    expect(await row()).toMatchObject({ state: 'not set up', observedAt: null });
  });

  it('with the key the setup saved: configured, never live on a setting alone; only where the key is kept is said', async () => {
    keep(KEY);
    const r = await row();
    expect(r).toMatchObject({ state: 'configured', observedAt: null, setup: 'timmy workspace check', words: 'set up, not checked yet (a setting is not a connection)' });
    expect(r.detail).toBe('remote inference on ollama.com (cloud, no local weights); local-only refuses it; no price per request is known here, so free-only refuses it too; key from providers.json in the Timmy home (0600)');
    expect(JSON.stringify(r)).not.toContain(KEY);
    // OLLAMA_API_KEY is used before the saved key, as Ollama's own clients read it
    env.OLLAMA_API_KEY = OTHER;
    expect((await row()).detail).toMatch(/; key from OLLAMA_API_KEY in this environment$/);
  });

  it('a check with this key: live within 30 min, older configured, refused, no answer unreachable; one with another key is no observation of it', async () => {
    keep(KEY);
    const asked = keyFingerprint(KEY);
    observed({ answer: 'accepted', at: ago(60_000), detail: 'it lists 3 models; none was run', asked });
    expect(await row()).toMatchObject({ state: 'live', observedAt: ago(60_000), words: 'answered 1 min ago (it lists 3 models; none was run); live: an answer within the last 30 min' });
    observed({ answer: 'accepted', at: ago(LIVE_FOR_MS + 60_000), detail: 'it lists 3 models; none was run', asked });
    expect(await row()).toMatchObject({ state: 'configured', words: expect.stringContaining('check again to see it now') });
    observed({ answer: 'refused', at: ago(120_000), detail: 'HTTP 401: Ollama refused the key', asked });
    expect(await row()).toMatchObject({ state: 'refused', words: 'refused when checked 2 min ago (HTTP 401: Ollama refused the key)' });
    observed({ answer: 'no answer', at: ago(120_000), detail: 'the connection failed (ENOTFOUND)', asked });
    expect(await row()).toMatchObject({ state: 'unreachable', words: 'no answer when checked 2 min ago (the connection failed (ENOTFOUND))' });
    // the last check asked with another key: says so, observes nothing of this one
    observed({ answer: 'accepted', at: ago(60_000), detail: 'it lists 3 models; none was run', asked: keyFingerprint(OTHER) });
    const other = await row();
    expect(other).toMatchObject({ state: 'configured', observedAt: null });
    expect(other.detail).toMatch(/; not checked with this key yet \(the last check asked with another key\)$/);
  });

  it('with local-only on, says chat never uses it', async () => {
    keep(KEY);
    env.TIMMY_CHAT_LOCAL_ONLY = '1';
    expect((await row()).detail).toMatch(/^remote inference on ollama\.com \(cloud, no local weights\); local-only is on, so chat never uses it; /);
  });
});

describe('timmy workspace check (checkConnections) and Ollama Cloud', () => {
  // FAKE answers for every other service, so nothing is asked of the network
  const others = {
    openRouter: async () => 'no-key' as const, key: () => null,
    ollama: async () => ({ ok: false, models: [] as string[], answer: { state: 'no answer', why: 'FAKE: nothing listens' } }),
    studio: async () => ({ state: 'not-running' }), companion: async () => 'refused' as const,
  };

  it('with its key set up: lists its models once with that key (a FAKE list), and records the key\'s fingerprint, never the key', async () => {
    keep(KEY);
    const asked: string[] = [];
    const { record, path } = await checkConnections({ env, cwd: project, now: () => NOW, ...others, ollamaCloud: async (k) => { asked.push(k); return { ok: true, models: [{}, {}, {}] }; } });
    expect(asked).toEqual([KEY]);
    expect(record.checks['ollama-cloud']).toEqual({ answer: 'accepted', at: new Date(NOW).toISOString(), detail: 'it lists 3 models; none was run', asked: keyFingerprint(KEY) });
    expect(path).toBe(connectionsPath(env));
    expect(readFileSync(path, 'utf8')).not.toContain(KEY);
    // the row reads what the check wrote
    expect(await row()).toMatchObject({ state: 'live', words: 'answered just now (it lists 3 models; none was run); live: an answer within the last 30 min' });
  });

  it('a refused key is refused, a failed request no answer; with no key nothing is asked, and an old observation is dropped', async () => {
    keep(KEY);
    let r = await checkConnections({ env, cwd: project, now: () => NOW, ...others, ollamaCloud: async () => ({ ok: false, why: 'Ollama refused the key (HTTP 401)', status: 401 }) });
    expect(r.record.checks['ollama-cloud']).toMatchObject({ answer: 'refused', detail: 'HTTP 401: Ollama refused the key', asked: keyFingerprint(KEY) });
    r = await checkConnections({ env, cwd: project, now: () => NOW, ...others, ollamaCloud: async () => ({ ok: false, why: 'the connection failed (ENOTFOUND)' }) });
    expect(r.record.checks['ollama-cloud']).toMatchObject({ answer: 'no answer', detail: 'the connection failed (ENOTFOUND)' });
    rmSync(join(home, 'timmy', 'providers.json'));
    let called = 0;
    r = await checkConnections({ env, cwd: project, now: () => NOW, ...others, ollamaCloud: async () => { called++; return { ok: true, models: [] }; } });
    expect(called).toBe(0);
    expect(r.record.checks['ollama-cloud']).toBeUndefined();
    expect(readConnections(env).checks['ollama-cloud']).toBeUndefined();
  });
});
