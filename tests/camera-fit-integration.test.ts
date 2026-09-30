import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { visualPythonExecutable } from '../src/vision/integrations/registry.js';

const root = resolve('.');
const python = visualPythonExecutable(root);
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// Tiny arithmetic test data, not a collected scene or benchmark episode.
function request() {
  const pair = (world: number[], id: string) => ({ id, world,
    pixel: [800 * (world[0] + 0.2) / (world[2] + 6) + 640,
      810 * (world[1] - 0.15) / (world[2] + 6) + 360] });
  const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-0.7, 0.7].map(z => [x, y, z])));
  return { operation: 'fit', object_id: 'unit-test-object', source_revision: 'a'.repeat(64),
    frame_id: 'unit-test-world', units: 'm', image_size: [1280, 720],
    camera_matrix: [[800, 0, 640], [0, 810, 360], [0, 0, 1]], distortion: [],
    correspondences: corners.map((p, i) => pair(p, `fit-${i}`)),
    validation_correspondences: [[0.2, 0.3, 0.4], [-0.4, 0.1, 0.2], [0.3, -0.2, -0.4]].map((p, i) => pair(p, `check-${i}`)) };
}

function invoke(input: ReturnType<typeof request>, check: (process: ReturnType<typeof spawnSync>, directory: string) => void) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'timmy-camera-cli-')));
  try {
    const file = join(directory, 'request.json');
    writeFileSync(file, JSON.stringify(input));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'vision', 'integrations', 'run', 'camera-fit', '--request', file], {
      cwd: root, env: { ...process.env, NODE_ENV: 'test', TIMMY_STORE: join(directory, 'receipts') },
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    check(result, directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe.skipIf(!existsSync(python))('camera-fit through the real source CLI (requires configured visual Python; otherwise skipped)', () => {
  it('dispatches, fits, retains source-bound artifacts and records intent/result', () => {
    invoke(request(), result => {
      expect(result.error).toBeUndefined();
      expect(result.status, String(result.stderr)).toBe(0);
      const report = JSON.parse(String(result.stdout));
      expect(report).toMatchObject({ ok: true, capability: 'camera-fit', operation: 'fit', signatureVerified: true, limits: { executedRetainedAdapterSnapshot: true } });
      expect(report.result).toMatchObject({ provenance: 'reconstructed', source_revision: 'a'.repeat(64),
        limits: { source_edited: false, geometry_truth: false, model_calls: 0, validation_used_for_fit: false } });
      report.result.world_to_camera.translation.forEach((x: number, i: number) => expect(x).toBeCloseTo([0.2, -0.15, 6][i], 8));
      expect(report.result.validation_residuals.rmse).toBeLessThan(1e-7);
      expect(report.artifacts).toHaveLength(1);
      const artifact = join(report.reportPath, '..', report.artifacts[0].path);
      expect(sha(readFileSync(artifact))).toBe(report.artifacts[0].sha256);
      const receipt = JSON.parse(readFileSync(join(report.reportPath, '..', 'receipt.json'), 'utf8'));
      expect(receipt.kind).toBe('vision.integration.result');
      expect(receipt.plan_hash).toBe(report.admissionReceipt);
    });
  });

  it('retains an actual adapter refusal when fitting and validation IDs overlap', () => {
    const input = request();
    input.validation_correspondences[0].id = input.correspondences[0].id;
    invoke(input, result => {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const report = JSON.parse(String(result.stdout));
      expect(report).toMatchObject({ ok: false, exitCode: 2, signatureVerified: true });
      expect(report.result.error).toBe('fit_validation_id_overlap');
      expect(report.artifacts).toHaveLength(1);
      const original = JSON.parse(readFileSync(join(report.reportPath, '..', report.artifacts[0].path), 'utf8'));
      expect(original).toMatchObject({ ok: false, error: 'fit_validation_id_overlap' });
    });
  });
});
