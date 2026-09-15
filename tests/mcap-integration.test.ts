import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { telemetryPythonExecutable } from '../src/vision/integrations/registry.js';
const root = resolve('.');
const python = process.env.TIMMY_TEST_TELEMETRY_PYTHON ?? telemetryPythonExecutable(root);
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function invoke(request: object, directory: string) {
  const file = join(directory, 'request.json'); writeFileSync(file, JSON.stringify(request));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'vision', 'integrations', 'run', 'mcap', '--request', file], {
    cwd: root, env: { ...process.env, NODE_ENV: 'test', TIMMY_STORE: join(directory, 'receipts'), TIMMY_TELEMETRY_PYTHON: python },
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  return { exit: result.status, report: JSON.parse(result.stdout) };
}
describe.skipIf(!existsSync(python))('MCAP through the real source CLI (optional native runtime)', () => {
  it('records and independently reopens indexed MCAP, retains exact rows and unknown fields', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'timmy-mcap-cli-')));
    try {
      const input = resolve('examples/visual-tools/simulation.json');
      const source = readFileSync(input);
      const recorded = invoke({ operation: 'export', input }, directory);
      expect(recorded.exit).toBe(0);
      const r = recorded.report;
      expect(r).toMatchObject({ ok: true, signatureVerified: true, limits: { executedRetainedAdapterSnapshot: true } });
      expect(Object.values(r.result.checks).every(v => v === true)).toBe(true);
      expect(readFileSync(input)).toEqual(source);
      expect(r.result.source.sha256).toBe(sha(source));
      const mcap = r.artifacts.find((f: any) => f.path.endsWith('.mcap'));
      const csv = r.artifacts.find((f: any) => f.path.endsWith('.csv'));
      const mcapPath = join(r.reportPath, '..', mcap.path);
      expect(sha(readFileSync(mcapPath))).toBe(mcap.sha256);
      const csvLines = readFileSync(join(r.reportPath, '..', csv.path), 'utf8').trimEnd().split(/\r?\n/);
      expect(csvLines.slice(1).every(l => l.endsWith(','))).toBe(true); // unknown penetration remains blank
      const replayed = invoke({ operation: 'replay', input: mcapPath }, directory);
      expect(replayed.exit).toBe(0);
      expect(replayed.report.result).toMatchObject({ crcValidated: true, messages: 6 });
      const json = replayed.report.artifacts.find((f: any) => f.path.endsWith('replayed.json'));
      const rows = JSON.parse(readFileSync(join(replayed.report.reportPath, '..', json.path), 'utf8')).rows;
      expect(rows).toEqual(JSON.parse(source.toString()).rows);
      expect(rows.every((r: any) => !Object.hasOwn(r, 'penetrationMetres'))).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('retains a failed result for invalid simulation data', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'timmy-mcap-bad-')));
    try {
      const input = join(directory, 'bad.json');
      writeFileSync(input, '{"rows":[{"timeSeconds":-1,"positionMetres":[0,0,0],"contactCount":0}]}');
      const { exit, report } = invoke({ operation: 'export', input }, directory);
      expect(exit).toBe(1);
      expect(report).toMatchObject({ ok: false, signatureVerified: true });
      expect(report.artifacts).toEqual([]);
      expect(report.result.ok).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
