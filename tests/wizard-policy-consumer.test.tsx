import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })), spawn: vi.fn(() => { throw new Error('Unexpected process spawn in policy test'); }),
}));
vi.mock('../src/harness/commander.js', () => ({
  edgeToken: () => null,
  CommanderClient: class { online = false; connect() {} close() {} send() { throw new Error('Unexpected commander send'); } },
}));
vi.mock('../src/utils/dispatch.js', () => ({ listLanes: () => [] }));
vi.mock('../src/models/registry.js', () => ({ listModelsSync: () => [], readNotes: () => '', notesPath: () => 'unused' }));
vi.mock('../src/bus/index.js', () => ({ subscribe: () => ({ stop() {} }), publish: () => {} }));
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { saveWizardSettings, loadWizardSettings, wizardConfigPaths } from '../src/tui/wizard-config.js';
import { policyPath, policyRoot, readPolicy, setModel } from '../src/harness/policy.js';
import { readChain } from '../src/utils/receipts.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'timmy-policy-consumer-'));
  vi.stubEnv('TIMMY_POLICY_DIR', root); vi.stubEnv('TIMMY_PRIVATE_DIR', join(root, '.timmy/private'));
  vi.stubEnv('TIMMY_STORE', join(root, '.timmy/receipts')); vi.stubEnv('TIMMY_REPO_ROOT', root);
  vi.stubEnv('TIMMY_SIGNAL_DIR', join(root, 'absent-signal')); vi.stubEnv('TIMMY_DEMO', ''); vi.stubEnv('TIMMY_WIZARD_DRY', '');
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const values = { operator: 'Synthetic operator', edge: 'edge.example.invalid', commander: '', policy: 'synthetic/wizard-model' };

describe('wizard model policy consumers', () => {
  it('shares wizard policy with the actual shell under the normal receipt-store layout', async () => {
    saveWizardSettings(values, root);
    const view = render(<ShellV2 width={120} />);
    try {
      for (let attempt = 0; attempt < 30 && !view.lastFrame()?.includes('YOUR JOURNEY'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(view.lastFrame()).toContain('wizard-model');
      expect(readPolicy().default).toBe(values.policy);
      expect(existsSync(join(root, '.timmy/.timmy/model-policy.json'))).toBe(false);
      // A wizard-saved default must not trigger shell auto-seeding elsewhere.
      expect(readChain('runs')).toEqual([]);
    } finally { view.unmount(); }
  });
  it('honors a policy override consistently without tying it to receipts or the wizard caller', () => {
    const caller = join(root, 'caller');
    expect(wizardConfigPaths(caller).policy).toBe(policyPath());
    saveWizardSettings(values, caller);
    expect(readPolicy().default).toBe(values.policy);
    expect(loadWizardSettings(caller).policy).toBe(values.policy);
    expect(existsSync(join(caller, '.timmy/model-policy.json'))).toBe(false);
    setModel('synthetic/new-policy', null);
    expect(loadWizardSettings(caller).policy).toBe('synthetic/new-policy');
    expect(policyRoot(caller)).toBe(caller); // explicit low-level API directories retain their semantics
  });
});
