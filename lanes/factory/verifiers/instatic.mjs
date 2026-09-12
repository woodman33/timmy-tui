// lanes/factory/verifiers/instatic.mjs — the Instatic/Paper snapshot: a self-describing site folder whose manifest
// hashes the take, so the winner can be served or diffed later without trusting a screenshot.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
export const name = 'instatic_snapshot';
export function verify(file, prediction, { dir, take, status }) {
  const bytes = readFileSync(file);
  const sha256 = 'sha256_' + createHash('sha256').update(bytes).digest('hex');
  const folder = join(dir, `take-${take}`);
  mkdirSync(folder, { recursive: true });
  const target = prediction.target === 'site' ? 'index.html' : 'scene.json';
  writeFileSync(join(folder, target), bytes);
  const manifest = { schema: 'timmy.instatic-site/1', name: `omma-take-${take}`, source: basename(file), entry: target, sha256, bytes: bytes.length, status, target: prediction.target, prediction_sha256: prediction.sha256, snapshot_at: new Date().toISOString() };
  writeFileSync(join(folder, 'site.json'), JSON.stringify(manifest, null, 1) + '\n');
  return { name, ran: true, ok: true, folder, sha256 };
}
