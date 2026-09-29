import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWizardSettings, saveWizardSettings, validateWizardValue, wizardConfigPaths, type WizardValues } from '../src/tui/wizard-config.js';
import { WizardScreen } from '../src/tui/wizard.js';
import { edgeHost, operatorLabel } from '../src/utils/edge-host.js';
import { defaultProfile } from '../src/harness/warroom.js';
import { modelFor } from '../src/harness/policy.js';
import { privateDir, readPrivateJson } from '../lanes/privacy/overlay.mjs';

let root: string;
const values: WizardValues = { operator: 'Example operator', edge: 'edge.example.invalid', commander: 'ws://127.0.0.1:9876/events', policy: 'example/model' };
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const json = (path: string, value: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'timmy-wizard-'));
  vi.stubEnv('TIMMY_POLICY_DIR', root);
  vi.stubEnv('TIMMY_PRIVATE_DIR', join(root, '.timmy', 'private'));
  vi.stubEnv('TIMMY_OPERATOR_LABEL', 'Env operator'); vi.stubEnv('TIMMY_OPERATOR_ID', 'op_example');
  vi.stubEnv('TIMMY_EDGE_HOST', 'env.example.invalid'); vi.stubEnv('TIMMY_COMMANDER_WS', 'ws://127.0.0.1:1234');
  vi.stubEnv('TIMMY_DEMO', ''); vi.stubEnv('TIMMY_WIZARD_DRY', '');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('private settings wizard', () => {
  it('resolves the actual store pin, overlay/env identity and model policy', () => {
    const paths = wizardConfigPaths(root);
    json(paths.overlay, { operator_label: 'Overlay operator', operator_id: 'op_overlay', edge_host: 'overlay.example.invalid', commander_ws: 'wss://commander.example.invalid/ws' });
    json(paths.policy, { default: 'local/model', scopes: {} });
    writeFileSync(join(root, '.timmy', 'store-pin'), join(root, 'receipts'));
    expect(loadWizardSettings(root)).toEqual({ operator: 'Overlay operator', operatorId: 'op_overlay', edge: 'overlay.example.invalid', commander: 'wss://commander.example.invalid/ws', policy: 'local/model', store: join(root, 'receipts') });
    expect(privateDir()).toBe(join(root, '.timmy', 'private'));
  });
  it('persists values consumed by edge, commander and policy readers, preserving unrelated state and identity', () => {
    const paths = wizardConfigPaths(root);
    json(paths.overlay, { operator_id: 'op_existing', first_project: 'keep-project', unrelated: { fake_token: 'fictional-retained-value' } });
    json(paths.policy, { default: null, scopes: { 'harness:pi': 'other/model' }, unrelated: 42 });
    chmodSync(join(root, '.timmy'), 0o755); chmodSync(join(root, '.timmy', 'private'), 0o755); chmodSync(paths.overlay, 0o644);
    expect(saveWizardSettings(values, root)).toEqual({ dry: false });
    expect(operatorLabel()).toBe(values.operator); expect(edgeHost()).toBe(values.edge); expect(defaultProfile().commander.ws).toBe(values.commander);
    expect(modelFor('hermes', root)).toBe(values.policy); expect(modelFor('pi', root)).toBe('other/model');
    expect(JSON.parse(readFileSync(paths.overlay, 'utf8'))).toMatchObject({ operator_id: 'op_existing', first_project: 'keep-project', unrelated: { fake_token: 'fictional-retained-value' } });
    expect(JSON.parse(readFileSync(paths.policy, 'utf8')).unrelated).toBe(42);
    for (const p of [join(root, '.timmy'), join(root, '.timmy', 'private')]) expect(statSync(p).mode & 0o777).toBe(0o700);
    for (const p of [paths.overlay, paths.policy]) expect(statSync(p).mode & 0o777).toBe(0o600);
  });
  it('observes private-directory overrides at call time and keeps environment fallbacks', () => {
    expect(loadWizardSettings(root).operatorId).toBe('op_example'); expect(defaultProfile().commander.ws).toBe('ws://127.0.0.1:1234');
    const other = join(root, 'other-private'); vi.stubEnv('TIMMY_PRIVATE_DIR', other);
    json(join(other, 'config.json'), { operator_label: 'Other operator', commander_ws: 'wss://other.example.invalid' });
    expect(operatorLabel()).toBe('Other operator'); expect(defaultProfile().commander.ws).toBe('wss://other.example.invalid');
    expect(readPrivateJson('config.json').path).toBe(join(other, 'config.json'));
  });
  it('preflights expanded policy size before changing either existing settings file', () => {
    const paths = wizardConfigPaths(root);
    json(paths.overlay, { operator_label: 'Keep original' });
    json(paths.policy, { default: 'keep/model', scopes: {}, preserved: Array(40000).fill(0) });
    const overlay = readFileSync(paths.overlay), policy = readFileSync(paths.policy);
    expect(policy.length).toBeLessThan(256 * 1024);
    expect(() => saveWizardSettings(values, root)).toThrow();
    expect(readFileSync(paths.overlay)).toEqual(overlay);
    expect(readFileSync(paths.policy)).toEqual(policy);
  });
  it('dry mode validates without making directories or changing files', () => {
    expect(saveWizardSettings(values, root, true)).toEqual({ dry: true });
    expect(existsSync(join(root, '.timmy'))).toBe(false);
    vi.stubEnv('TIMMY_WIZARD_DRY', '1'); saveWizardSettings(values, root);
    expect(existsSync(join(root, '.timmy'))).toBe(false);
    vi.stubEnv('TIMMY_WIZARD_DRY', ''); vi.stubEnv('TIMMY_DEMO', '1'); saveWizardSettings(values, root);
    expect(existsSync(join(root, '.timmy'))).toBe(false);
  });
  it.each(['malformed', 'array', 'oversized', 'symlink', 'hardlink', 'directory'])('refuses %s existing config without changing it or policy', kind => {
    const paths = wizardConfigPaths(root), outside = join(root, 'outside.json');
    json(outside, { keep: true }); mkdirSync(join(paths.overlay, '..'), { recursive: true });
    if (kind === 'symlink') symlinkSync(outside, paths.overlay);
    else if (kind === 'hardlink') linkSync(outside, paths.overlay);
    else if (kind === 'directory') mkdirSync(paths.overlay);
    else writeFileSync(paths.overlay, kind === 'array' ? '[]' : kind === 'oversized' ? ' '.repeat(300000) : '{broken');
    const outsideBefore = readFileSync(outside);
    expect(() => loadWizardSettings(root)).toThrow(); expect(() => saveWizardSettings(values, root)).toThrow();
    expect(readFileSync(outside)).toEqual(outsideBefore); expect(existsSync(paths.policy)).toBe(false);
  });
  it('refuses linked private directories and policy files before writing the overlay', () => {
    const outside = join(root, 'outside'); mkdirSync(outside); mkdirSync(join(root, '.timmy'));
    symlinkSync(outside, join(root, '.timmy', 'private'));
    expect(() => saveWizardSettings(values, root)).toThrow(); expect(existsSync(join(outside, 'config.json'))).toBe(false);
    rmSync(join(root, '.timmy', 'private')); mkdirSync(join(root, '.timmy', 'private'));
    json(join(outside, 'policy.json'), {}); symlinkSync(join(outside, 'policy.json'), wizardConfigPaths(root).policy);
    expect(() => saveWizardSettings(values, root)).toThrow(); expect(existsSync(wizardConfigPaths(root).overlay)).toBe(false);
  });
  it('rejects terminal controls and credential-bearing endpoints without displaying their values', () => {
    const credentialUrl = new URL('wss://example.invalid');
    credentialUrl.username = 'user'; credentialUrl.password = 'fictional-password';
    for (const [field, input] of [['operator', 'a\x1b[2J'], ['edge', 'https://edge.example.invalid'], ['commander', credentialUrl.href], ['commander', 'wss://example.invalid?token=fictional'], ['policy', 'model\nnext']] as const) {
      expect(() => validateWizardValue(field, input)).toThrow();
    }
    json(wizardConfigPaths(root).overlay, { commander_ws: credentialUrl.href });
    const view = render(<WizardScreen cwd={root} />);
    expect(view.lastFrame()).toContain('Settings unavailable'); expect(view.lastFrame()).not.toContain('fictional-password');
  });
  it('lets a user edit, save and reopen settings without changing operator identity', async () => {
    json(wizardConfigPaths(root).overlay, { operator_id: 'op_keep' });
    const view = render(<WizardScreen cwd={root} />); await tick();
    view.stdin.write('j'); await tick(); view.stdin.write('e'); await tick();
    for (let i = 0; i < 'Env operator'.length; i++) view.stdin.write('\x7f');
    await tick(); view.stdin.write('New label'); await tick(); view.stdin.write('\r'); await tick(); view.stdin.write('w'); await tick();
    expect(view.lastFrame()).toContain('Private settings saved');
    expect(loadWizardSettings(root).operator).toBe('New label'); expect(loadWizardSettings(root).operatorId).toBe('op_keep');
  });
  it('preserves config changes made after the screen opened', async () => {
    const paths = wizardConfigPaths(root); json(paths.overlay, { first_project: 'before' });
    const view = render(<WizardScreen cwd={root} />); await tick();
    json(paths.overlay, { first_project: 'after', extra: 'keep' }); view.stdin.write('w'); await tick();
    expect(JSON.parse(readFileSync(paths.overlay, 'utf8'))).toMatchObject({ first_project: 'after', extra: 'keep' });
  });
  it('imports the entry without rendering or writes and refuses a non-TTY invocation', async () => {
    const before = process.cwd(), spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runWizard } = await import('../src/tui/wizard-entry.js');
    expect(existsSync(join(root, '.timmy'))).toBe(false);
    expect(await runWizard(['--bad-flag'])).toBe(1);
    if (!process.stdin.isTTY || !process.stdout.isTTY) expect(await runWizard([])).toBe(1);
    expect(process.cwd()).toBe(before); expect(existsSync(join(root, '.timmy'))).toBe(false); expect(spy).toHaveBeenCalled();
  });
});
