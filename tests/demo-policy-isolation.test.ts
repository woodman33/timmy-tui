import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { readPolicy, policyPath, writePolicy } from '../src/harness/policy.js';
import { installDemoPolicy } from '../src/demo/fixture-policy.js';

const startup = vi.hoisted(() => ({ append: vi.fn(() => ({ hash: 'fixture-receipt' })), dockerHost: undefined as string | undefined, dockerContext: undefined as string | undefined, path: undefined as string | undefined }));
vi.mock('../src/utils/receipts.js', () => ({ appendReceipt: startup.append }));
vi.mock('../src/tui/components/ShellV2.js', () => ({ ShellV2: () => null }));
vi.mock('ink-testing-library', () => ({
  render: () => {
    startup.dockerHost = process.env.DOCKER_HOST;
    startup.dockerContext = process.env.DOCKER_CONTEXT;
    startup.path = process.env.PATH;
    throw new Error('DEMO_FIXTURE_STARTUP_STOP');
  },
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(() => { throw new Error('Native commands are forbidden in this startup test'); }),
}));

// Exercise the real policy reader and demo fixture setup without mounting the
// Shell or starting agg, ffmpeg, native tools, agents, or receipt writers.
describe('demo policy isolation', () => {
  it('seeds identical runs and preserves the inherited operator policy bytes', () => {
    const inherited = process.env.TIMMY_POLICY_DIR!;
    const root = dirname(process.env.TIMMY_STORE!);
    writePolicy({ default: 'operator/protected', scopes: { 'harness:fixture': 'operator/pinned' } });
    const before = readFileSync(policyPath());
    const fixtureBytes: Buffer[] = [];
    for (const name of ['demo-a', 'demo-b']) {
      const store = join(root, name);
      mkdirSync(store);
      const restore = installDemoPolicy(store);
      try {
        expect(process.env.TIMMY_POLICY_DIR).toBe(store);
        expect(readPolicy()).toEqual({ default: 'placeholder/auto', scopes: {} });
        fixtureBytes.push(readFileSync(policyPath()));
        // The first-run Shell policy effect must see a seeded default, so it
        // cannot add an incidental model.policy receipt to either fixture.
        expect(Boolean(readPolicy().default)).toBe(true);
        expect(readFileSync(policyPath(inherited))).toEqual(before);
      } finally { restore(); }
      expect(process.env.TIMMY_POLICY_DIR).toBe(inherited);
      expect(readFileSync(policyPath())).toEqual(before);
    }
    expect(fixtureBytes[0]).toEqual(fixtureBytes[1]);
  });

  it('restores an absent override and leaves the override intact on setup failure', () => {
    const root = dirname(process.env.TIMMY_STORE!);
    vi.stubEnv('TIMMY_POLICY_DIR', undefined);
    const restore = installDemoPolicy(join(root, 'without-parent-override'));
    restore();
    expect(process.env.TIMMY_POLICY_DIR).toBeUndefined();

    vi.stubEnv('TIMMY_POLICY_DIR', root);
    const blocked = join(root, 'regular-file');
    writeFileSync(blocked, 'fixture');
    expect(() => installDemoPolicy(blocked)).toThrow();
    expect(process.env.TIMMY_POLICY_DIR).toBe(root);
  });
  it('the real demo entry seeds its own policy before importing Shell on both runs', async () => {
    const inherited = process.env.TIMMY_POLICY_DIR!;
    writePolicy({ default: 'operator/protected', scopes: {} });
    const before = readFileSync(policyPath());
    const originalDate = globalThis.Date;
    const originalRandom = Math.random;
    const envKeys = ['TIMMY_STORE', 'TIMMY_DEMO', 'TIMMY_REPO_ROOT', 'TIMMY_PROJECTS_ROOT', 'TIMMY_POLICY_DIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'PATH'] as const;
    const inheritedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    const fixtureBytes: Buffer[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const name of ['startup-a', 'startup-b']) {
        vi.resetModules();
        startup.append.mockClear();
        const out = join(inherited, name);
        const originalArgv = process.argv;
        process.argv = ['node', 'src/demo/cast.ts', '--out', out, '--no-seal'];
        let stopped!: () => void;
        const done = new Promise<void>(resolve => { stopped = resolve; });
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => { stopped(); return undefined as never; });
        let fixtureRoot: string | undefined;
        try {
          process.env.DOCKER_HOST = 'unix:///operator-fixture.sock';
          process.env.DOCKER_CONTEXT = 'operator-fixture-context';
          await import('../src/demo/cast.js');
          await done;
          fixtureRoot = dirname(process.env.TIMMY_STORE!);
          expect(errors).toHaveBeenLastCalledWith(expect.stringContaining('DEMO_FIXTURE_STARTUP_STOP'));
          expect(exit).toHaveBeenCalledWith(1);
          expect(fixtureRoot).not.toBe(inherited);
          expect(startup.dockerHost).toBe(`unix://${join(fixtureRoot, 'docker-unavailable.sock')}`);
          expect(startup.dockerContext).toBeUndefined();
          expect(startup.path?.split(delimiter)[0]).toBe(join(fixtureRoot, 'bin'));
          expect(readFileSync(join(fixtureRoot, 'bin/docker'), 'utf8')).toBe('#!/bin/sh\nexit 1\n');
          expect(process.env.DOCKER_HOST).toBe('unix:///operator-fixture.sock');
          expect(process.env.DOCKER_CONTEXT).toBe('operator-fixture-context');
          expect(process.env.PATH).toBe(inheritedEnv.PATH);
          fixtureBytes.push(readFileSync(policyPath(fixtureRoot)));
          expect(readPolicy(fixtureRoot)).toEqual({ default: 'placeholder/auto', scopes: {} });
          expect(startup.append).toHaveBeenCalledTimes(7);
          expect(process.env.TIMMY_POLICY_DIR).toBe(inherited);
          expect(readFileSync(policyPath(inherited))).toEqual(before);
        } finally {
          exit.mockRestore();
          process.argv = originalArgv;
          globalThis.Date = originalDate;
          Math.random = originalRandom;
          for (const key of envKeys) {
            if (inheritedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = inheritedEnv[key];
          }
          if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
      expect(fixtureBytes[0]).toEqual(fixtureBytes[1]);
    } finally { errors.mockRestore(); }
  });

});
