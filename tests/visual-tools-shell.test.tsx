import React from 'react';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

// Keep the real shell, panel, policy reader, receipt reader and local export service.
// Discovery, remote connections and external programs cannot leave this test.
vi.mock('child_process', () => ({
  spawn: vi.fn(() => { throw new Error('Unexpected external process'); }),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  execSync: vi.fn(() => { throw new Error('Unexpected external command'); }),
}));
vi.mock('../src/bus/index.js', () => ({ subscribe: () => ({ stop() {} }) }));
vi.mock('../src/utils/dispatch.js', () => ({ listLanes: () => [] }));
vi.mock('../src/models/registry.js', () => ({
  listModelsSync: () => [{ id: 'fixture/first', notes: 'FIRST MODEL' }, { id: 'fixture/second', notes: 'SECOND MODEL' }],
  readNotes: () => ({}), notesPath: () => join(process.cwd(), 'notes.json'),
}));
vi.mock('../src/harness/policy.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/harness/policy.js')>();
  return { ...actual, setModel: vi.fn(() => { throw new Error('Visual panel must not change model policy'); }) };
});
vi.mock('../src/utils/receipts.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/receipts.js')>();
  return { ...actual, verifyChain: vi.fn(actual.verifyChain),
    appendReceipt: vi.fn(() => { throw new Error('Unsealed HTML export must not write a receipt'); }) };
});
vi.mock('../src/drop/index.js', () => ({ dropRoot: () => join(process.cwd(), 'drops'), SHIPPED_RULES: {} }));
vi.mock('../src/utils/escrow-engine.js', () => ({ listEscrows: () => [], lockEscrow: vi.fn(), cancelEscrow: vi.fn() }));
vi.mock('../src/harness/warroom.js', () => ({
  defaultProfile: () => ({ name: 'test', harnesses: [], commander: { ws: null, model: 'fixture/commander' } }),
  panes: () => [], setActivity: vi.fn(), killWar: vi.fn(),
}));
vi.mock('../src/harness/warroom2.js', () => ({
  swarmPresets: () => [], swarmRuns: () => [], nodeStats: () => [], sbxRuns: () => [],
  dockerPorts: () => ({}), abilities: () => [], projects: () => [], nodeForModel: () => null,
  modelFit: () => null, launchSwarm: vi.fn(), killSwarm: vi.fn(),
}));
vi.mock('../src/harness/uinext.js', () => ({ signalState: () => null, modelStrictness: () => [] }));
vi.mock('../src/harness/commander.js', () => ({
  CommanderClient: class { online = false; connect() {} close() {} }, edgeToken: () => null,
}));
vi.mock('../src/vision/integrations/registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/vision/integrations/registry.js')>(), integrationCatalog: () => [],
}));
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { appendReceipt, readChain, verifyChain } from '../src/utils/receipts.js';
import { policyPath, setModel, writePolicy } from '../src/harness/policy.js';
import open from 'open';
import { spawn, spawnSync } from 'child_process';

const tick = () => new Promise(resolve => setTimeout(resolve, 35));
async function key(view: ReturnType<typeof render>, value: string) { view.stdin.write(value); await tick(); }

describe('ShellV2 visual tools interaction', () => {
  it('opens from Library, creates a real local HTML artifact, isolates panel keys and returns', async () => {
    const originalCwd = process.cwd();
    const store = realpathSync(process.env.TIMMY_STORE!);
    const policyRoot = dirname(store);
    const workspace = join(policyRoot, 'workspace');
    mkdirSync(workspace);
    process.chdir(workspace);
    vi.stubEnv('TIMMY_STORE', store);
    vi.stubEnv('PATH', ''); // Catalog detection stays inside this fixture; no host executable lookup.
    const network = vi.fn(() => { throw new Error('Unexpected network call'); });
    vi.stubGlobal('fetch', network);
    const originalPolicy = { default: 'fixture/unchanged', scopes: {} };
    writePolicy(originalPolicy, policyRoot);
    writePolicy(originalPolicy, workspace);
    const policyBytes = readFileSync(policyPath(policyRoot));
    const inputName = 'visual story.json';
    writeFileSync(inputName, JSON.stringify({ id: 'shell-proof', title: 'LOCAL <PROOF>', duration: 2,
      beats: [{ at: 0, dur: 2, label: 'SOURCE', text: 'Made through the real Timmy panel' }] }));
    try {
      const view = render(<ShellV2 width={120} />);
      await tick();
      await key(view, '4');
      expect(view.lastFrame()).toContain('[V] VISUAL TOOLS');
      expect(view.lastFrame()).toContain('FIRST MODEL');
      const verificationCallsBefore = vi.mocked(verifyChain).mock.calls.length;
      await key(view, 'V');
      expect(view.lastFrame()).toContain('Camera alignment');
      await key(view, '\x1b[B');
      await key(view, '\x1b[B');
      await key(view, '\r');
      expect(view.lastFrame()).toContain('Storyboard JSON path');
      // An individual v is the shell's global verify key. It must remain path text here.
      await key(view, 'v');
      await key(view, 'isual story.jsonx');
      await key(view, '\x7f');
      expect(view.lastFrame()).toContain(inputName);
      expect(readdirSync(store)).not.toContain('visual-tools');
      await key(view, '\r');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('COMPLETED'), { timeout: 1500 });
      expect(view.lastFrame()).toContain('No video rendered; no receipt sealed');
      expect(view.lastFrame()).toContain('Completion is not geometry verification');
      expect(view.lastFrame()).toContain('Artifact:');
      const outputRoot = join(store, 'visual-tools');
      const exports = readdirSync(outputRoot);
      expect(exports).toHaveLength(1);
      const artifact = join(outputRoot, exports[0], 'index.html');
      const html = readFileSync(artifact, 'utf8');
      expect(html).toContain('<h1>Made through the real Timmy panel</h1>');
      expect(html).toContain('LOCAL &lt;PROOF&gt;');
      expect(html).toContain('window.__timelines');
      await key(view, '\x0f');
      await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(artifact));
      await key(view, '\x1b');
      expect(view.lastFrame()).toContain('Camera alignment');
      expect(view.lastFrame()).not.toContain('[V] VISUAL TOOLS');
      await key(view, '\x1b');
      expect(view.lastFrame()).toContain('[V] VISUAL TOOLS');
      expect(view.lastFrame()).toContain('FIRST MODEL');
      expect(view.lastFrame()).not.toContain('SECOND MODEL');
      expect(setModel).not.toHaveBeenCalled();
      expect(verifyChain).toHaveBeenCalledTimes(verificationCallsBefore);
      expect(appendReceipt).not.toHaveBeenCalled();
      expect(readChain('runs')).toEqual([]);
      expect(readFileSync(policyPath(policyRoot))).toEqual(policyBytes);
      expect(network).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).toHaveBeenCalledExactlyOnceWith('docker', ['info', '--format', 'ok'], { timeout: 2500, stdio: 'ignore' });
    } finally {
      cleanup();
      process.chdir(originalCwd);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
