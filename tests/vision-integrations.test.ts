import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrationCatalog, integrationDefinitions, visualPythonExecutable } from '../src/vision/integrations/registry.js';
import { validateIntegrationRequest, hashArtifacts, runIntegration } from '../src/vision/integrations/runner.js';
import { readChain, verifySignature } from '../src/utils/receipts.js';

describe('Timmy visual integration admission', () => {
  it('keeps the shipped camera adapter independent from the caller working directory', () => {
    const first = integrationDefinitions('/unrelated-working-directory').find(item => item.id === 'camera-fit')!;
    const second = integrationDefinitions('/another-working-directory').find(item => item.id === 'camera-fit')!;
    expect(first.script).toBe(second.script);
    expect(readFileSync(first.script, 'utf8')).toContain('def compute(request):');
    expect(visualPythonExecutable('/project', {})).toBe('/project/.timmy/venv-visual/bin/python');
    expect(visualPythonExecutable('/project', { TIMMY_VISUAL_PYTHON: '/configured/python' })).toBe('/configured/python');
    expect(() => visualPythonExecutable('/project', { TIMMY_VISUAL_PYTHON: 'python' })).toThrow('absolute');
  });
  it('does not claim runtime qualification from adapter presence', () => {
    const catalog = integrationCatalog('/does-not-exist');
    expect(catalog.filter(item => item.id !== 'camera-fit').every(item => !item.installedAdapter)).toBe(true);
    expect(catalog.find(item => item.id === 'camera-fit')!.installedAdapter)
      .toBe(existsSync(visualPythonExecutable('/does-not-exist')));
    expect(catalog.every(item => item.qualification.includes('presence is not qualification'))).toBe(true);
  });
  it.each([
    ['mcap', { operation: 'shell' }], ['invented', { operation: 'probe' }],
    ['mcap', { operation: 'probe', env: {} }], ['mcap', { operation: 'probe', output_dir: '/tmp' }],
    ['mcap', { operation: 'probe', nested: { api_key: 'secret' } }],
    ['mcap', { operation: 'probe', admission_receipt_hash: 'forged' }],
  ])('refuses authority-expanding input %j', (id, request) => {
    expect(() => validateIntegrationRequest(id as string, request)).toThrow();
  });
  it('seals missing-runtime failure after intent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'timmy-integration-test-'));
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
      const result = await runIntegration('mcap', { operation: 'probe' }, root);
      expect(result.ok).toBe(false); expect(result.signatureVerified).toBe(true);
      const chain = readChain('runs', root);
      expect(chain.map(r => r.kind)).toEqual(['vision.integration.intent', 'vision.integration.result']);
      expect(chain[1].status).toBe('failed'); expect(chain[1].plan_hash).toBe(chain[0].hash);
      expect(chain.every(verifySignature)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('hashes owned artifact bytes and rejects escapes and symlinks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'timmy-artifacts-test-'));
    try {
      const file = join(root, 'owned.txt'); writeFileSync(file, 'measured');
      expect((await hashArtifacts(root, [file]))[0]).toMatchObject({ path: 'owned.txt', bytes: 8 });
      await expect(hashArtifacts(root, [join(root, '../outside.txt')])).rejects.toThrow('inside');
      symlinkSync(file, join(root, 'link.txt'));
      await expect(hashArtifacts(root, [join(root, 'link.txt')])).rejects.toThrow('Linked');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('retains bounded diagnostics when a child exceeds the output limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'timmy-output-limit-test-'));
    try {
      const bin = join(root, '.timmy/venv-platform-telemetry/bin');
      const adapter = join(root, 'tools/platform-vision-20260910/telemetry');
      mkdirSync(bin, { recursive: true }); mkdirSync(adapter, { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"name":"fixture","type":"commonjs"}');
      // A fixed test runtime at the registered path; no request can select it.
      writeFileSync(join(bin, 'python'), `#!${process.execPath}\nprocess.stderr.write('failure-context\\n'); process.stdout.write('observed-before-limit\\n'); setTimeout(() => process.stdout.write('x'.repeat(5*1024*1024)),30);`, { mode: 0o700 });
      const result = await runIntegration('mcap', { operation: 'probe' }, root);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('4 MiB');
      expect(readFileSync(join(result.reportPath, '../stderr.txt'), 'utf8')).toContain('failure-context');
      expect(readFileSync(join(result.reportPath, '../stdout.txt'), 'utf8')).toContain('observed-before-limit');
      expect(result.signatureVerified).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
