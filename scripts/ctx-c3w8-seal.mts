import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { appendReceipt, verifySignature, type Receipt } from '../src/utils/receipts.js';
import { captureEnvLock } from '../src/utils/envlock.js';

export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function retain(path: string, data: unknown) {
  const bytes = JSON.stringify(data, null, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: 'wx' });
  return { path: relative(process.cwd(), path), sha256: digest(bytes), bytes: Buffer.byteLength(bytes) };
}
export function seal(kind: string, artifact: { path: string; sha256: string }, parent?: Receipt, status: 'ok'|'failed'|'denied' = 'ok') {
  if (digest(readFileSync(artifact.path)) !== artifact.sha256) throw new Error('Artifact changed before seal.');
  const receipt = appendReceipt('runs', { kind, subject: 'ORDER ctx-c3w8', policy: 'User authorized local evidence and proposal-only work; HOLD released', status,
    env_lock: captureEnvLock([]), output_sha256: artifact.sha256, artifacts: [artifact.path], ...(parent ? { plan_hash: parent.hash } : {}),
  });
  if (!verifySignature(receipt)) throw new Error('Receipt signature failed.');
  retain(artifact.path + '.seal.json', receipt);
  return receipt;
}
