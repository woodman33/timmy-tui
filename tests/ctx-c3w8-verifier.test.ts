import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalBody } from '../src/utils/signing.js';
import { hashOf } from '../src/utils/receipts.js';
import { recomputeScore, safeRelativePath, verifyEvidence, verifyReceiptIntegrity } from '../scripts/ctx-c3w8-verify.mjs';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function receipt() {
  const keys = generateKeyPairSync('ed25519');
  const body = { v: 1, id: 'rc_test', stream: 'runs', kind: 'test', ts: '2026-09-12T10:00:00.000Z', prev_hash: 'sha256_' + 'b'.repeat(64), signer: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(), output_sha256: 'c'.repeat(64) };
  const signature = sign(null, Buffer.from(canonicalBody(body)), keys.privateKey).toString('base64');
  return { ...body, signature, hash: hashOf({ ...body, signature, hash: '' }) };
}
const rubric = { absoluteTolerance: 1e-6, counts: { knownLocations: 1000, totalCells: 1000, empty: 488, partial: 96, full: 416 }, physical: { material: null, densityKgM3: null, massKg: null } };
const factIds: Record<string, string> = { knownLocations: 'volume.location-count', totalCells: 'volume.total-cells', empty: 'volume.fill-coverage', partial: 'volume.fill-coverage', full: 'volume.fill-coverage', material: 'volume.material', densityKgM3: 'volume.density', massKg: 'volume.density' };
const context = { facts: [...new Set(Object.values(factIds))].map(id => ({ id, entityId: 'volume' })) };
function row(questionId: 'counts' | 'physical', condition: 'pack' | 'no-pack') {
  return { questionId, condition, error: null, raw: { answers: Object.entries(rubric[questionId]).map(([key, value]) => ({ key, value, entityId: condition === 'pack' ? 'volume' : null, factIds: condition === 'pack' ? [factIds[key]] : [] })), unknowns: ['material', 'density', 'mass'] } };
}

describe('ORDER evidence integrity', () => {
  it('checks both self-hash and Ed25519 signature with an external previous-link boundary', () => {
    const original = receipt();
    expect(verifyReceiptIntegrity(original).hash).toBe(original.hash);
    const changed = { ...original, output_sha256: createHash('sha256').update('changed').digest('hex') };
    expect(() => verifyReceiptIntegrity(changed)).toThrow(/self-hash/);
    changed.hash = hashOf({ ...changed, hash: '' });
    expect(() => verifyReceiptIntegrity(changed)).toThrow(/signature mismatch/);
  });
  it('rejects traversal and symlink evidence instead of reading outside the declared workspace', () => {
    for (const path of ['../escape', '/absolute', 'x/../escape', 'C:\\escape', 'x//y', './file', 'file\u0000']) expect(() => safeRelativePath(path)).toThrow(/Unsafe/);
    const root = mkdtempSync(join(tmpdir(), 'timmy-verifier-path-')); directories.push(root);
    mkdirSync(join(root, 'studio/ctx-c3w8'), { recursive: true });
    symlinkSync(tmpdir(), join(root, 'studio/ctx-c3w8/escape'));
    expect(() => verifyEvidence(root)).toThrow(/symlink|leaves workspace/);
  });
  it('fails when required checkpoints are absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'timmy-verifier-missing-')); directories.push(root);
    mkdirSync(join(root, 'studio/ctx-c3w8'), { recursive: true });
    expect(() => verifyEvidence(root)).toThrow(/ctx.c1.predict/);
  });
});

describe('independent frozen-rubric arithmetic', () => {
  it('separates factual correctness, grounding, unknown preservation and coverage', () => {
    expect(recomputeScore(row('counts', 'pack'), rubric, context)).toMatchObject({ valid: true, correct: true, groundedCorrect: 1, unknownsPreserved: 1, score: 2, answerCoverage: 1 });
    const guess = row('counts', 'no-pack');
    expect(recomputeScore(guess, rubric, context)).toMatchObject({ correct: true, groundedCorrect: 0, unknownsPreserved: 1, score: 1 });
    const abstention = row('physical', 'no-pack');
    expect(recomputeScore(abstention, rubric, context)).toMatchObject({ correct: true, groundedCorrect: 1, unknownsPreserved: 1, score: 2, answerCoverage: 0 });
  });
  it('preserves failures and rejects duplicate keys or invented material', () => {
    expect(recomputeScore({ error: 'timeout' }, rubric, context)).toMatchObject({ valid: false, score: 0, error: 'timeout' });
    const duplicate = row('physical', 'pack'); duplicate.raw.answers[1] = { ...duplicate.raw.answers[0] };
    expect(recomputeScore(duplicate, rubric, context)).toMatchObject({ valid: false, score: 0 });
    const invented = row('physical', 'pack'); (invented.raw.answers[0] as any).value = 'steel';
    expect(recomputeScore(invented, rubric, context)).toMatchObject({ valid: true, correct: false, groundedCorrect: 0, unknownsPreserved: 0, score: 0 });
  });
});
