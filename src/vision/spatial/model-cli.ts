import { buildVolumeModelContext } from './model-context.js';
import { buildNativeModelContext } from './native-model-context.js';
import { localSpatialModels, reviewSpatialContext } from './local-model-review.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { appendReceipt } from '../../utils/receipts.js';
import { captureEnvLock } from '../../utils/envlock.js';
import { readSealedContextPack, sealSpatialAnnotation, spatialBytesHash, type SpatialArtifactSeal } from './context-pack.js';
import { readSpatialPackDescriptor, retainSpatialDescriptor, spatialCliOutputDirectory } from './context-order-cli.js';

const HELP = [
  'timmy vision spatial models list [--json]',
  'timmy vision spatial models context <source.json> [--kind volume|spline|hana] [--object ID] [--json]',
  'timmy vision spatial models review <source.json> --model NAME --question TEXT [--kind volume|spline|hana] [--object ID] [--image FILE] [--json]',
  'timmy vision spatial models review-pack <pack.descriptor.json> --model NAME --question TEXT --out <directory> [--json]',
  'Volume sources are verified manifests. Spline/Hana sources are retained MCP envelopes.',
  'Review calls a locally installed Ollama model and records signed execution receipts. Comments remain proposals; no native edits execute.',
].join('\n');

function retainPackReviewFailure(packSeal: SpatialArtifactSeal, error: string, outputDir: string, dir: string, reviewReceipt?: string) {
  const payload = { schema: 'timmy.spatial-pack-review.failure/1', ok: false, packSha256: packSeal.artifact.sha256,
    sourceRevision: packSeal.receipt.manifest_sha256, error, reviewReceipt: reviewReceipt ?? null,
    scope: { annotationProduced: false, nativeEditsExecuted: false } };
  const bytes = JSON.stringify(payload, null, 2) + '\n', sha256 = spatialBytesHash(bytes);
  const path = join(outputDir, `pack-review-failure-${randomUUID()}.json`);
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o444 });
  const artifact = { path: relative(resolve(dir), path), sha256, bytes: Buffer.byteLength(bytes) };
  const receipt = appendReceipt('runs', { kind: 'spatial.pack.review', subject: 'sealed spatial context review',
    policy: 'Retain failed local review without promoting an annotation', status: 'failed', plan_hash: packSeal.receipt.hash,
    output_sha256: sha256, artifacts: [artifact.path], manifest_sha256: packSeal.receipt.manifest_sha256,
    ...(reviewReceipt ? { child_receipts: [reviewReceipt] } : {}), env_lock: captureEnvLock([], dir) }, dir);
  const failure = { artifact, receipt };
  return { ...payload, ...failure, descriptorPath: retainSpatialDescriptor(failure, dir) };
}

async function reviewPack(source: string, flags: Record<string, string | boolean>, out: (s: string) => void, dir: string) {
  if (typeof flags['--model'] !== 'string' || typeof flags['--question'] !== 'string' || typeof flags['--out'] !== 'string') {
    out('Pack review requires --model, --question and --out.'); return 2;
  }
  const packSeal = readSpatialPackDescriptor(source, dir), pack = readSealedContextPack(packSeal, dir);
  const outputDir = spatialCliOutputDirectory(flags['--out'], dir);
  let result: Awaited<ReturnType<typeof reviewSpatialContext>>;
  try { result = await reviewSpatialContext(pack.context, { model: flags['--model'], question: flags['--question'], dir }); }
  catch (error) {
    out(JSON.stringify(retainPackReviewFailure(packSeal, error instanceof Error ? error.message : 'Local pack review failed.', outputDir, dir), null, 2)); return 1;
  }
  if (!result.ok || !result.review) {
    out(JSON.stringify(retainPackReviewFailure(packSeal, result.error ?? 'Local model returned no admitted review.', outputDir, dir, result.receiptHash), null, 2)); return 1;
  }
  const annotation = sealSpatialAnnotation(packSeal, { camera: pack.camera, review: result.review }, { outputDir, sourceRoot: dir, receiptDir: dir });
  const descriptorPath = retainSpatialDescriptor(annotation, dir), ok = annotation.result.status === 'grounded';
  out(JSON.stringify({ ok, descriptorPath, review: result, annotation }, null, 2)); return ok ? 0 : 1;
}
export function contextFromSource(path: string, kind = 'volume', objectId?: string) {
  if (kind === 'volume') { if (objectId) throw new Error('--object is for native sources.'); return buildVolumeModelContext(path); }
  if (kind === 'spline' || kind === 'hana') return buildNativeModelContext(path, kind, objectId);
  throw new Error('Supported source kinds: volume, spline, hana.');
}
export async function runModelCli(args: string[], out: (s: string) => void = console.log, dir = process.cwd()) {
  if (!args.length || args.includes('--help')) { out(HELP); return 0; }
  const operation = args[0];
  if (!['list', 'context', 'review', 'review-pack'].includes(operation)) { out(HELP); return 2; }
  const source = operation === 'list' ? undefined : args[1], flags: Record<string, string | boolean> = {};
  if (operation !== 'list' && (!source || source.startsWith('-'))) { out(HELP); return 2; }
  const allowed = operation === 'list' ? ['--json'] : operation === 'context' ? ['--kind', '--object', '--json'] : operation === 'review-pack' ? ['--json', '--model', '--question', '--out'] : ['--kind', '--object', '--json', '--model', '--question', '--image'];
  for (let i = operation === 'list' ? 1 : 2; i < args.length; i++) {
    const key = args[i]; if (!allowed.includes(key) || key in flags) { out('Unknown or duplicate model option.'); return 2; }
    if (key === '--json') flags[key] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) { out('Missing option value.'); return 2; } flags[key] = args[++i]; }
  }
  try {
    if (operation === 'list') { out(JSON.stringify(await localSpatialModels(), null, 2)); return 0; }
    if (operation === 'review-pack') return await reviewPack(source!, flags, out, dir);
    const context = contextFromSource(source!, flags['--kind'] as string | undefined, flags['--object'] as string | undefined);
    if (operation === 'context') { out(JSON.stringify(context, null, 2)); return 0; }
    if (typeof flags['--model'] !== 'string' || typeof flags['--question'] !== 'string') { out('Review requires --model and --question.'); return 2; }
    const result = await reviewSpatialContext(context, { model: flags['--model'], question: flags['--question'], imagePath: flags['--image'] as string | undefined, dir });
    out(flags['--json'] ? JSON.stringify(result, null, 2) : [
      `TIMMY / LOCAL SPATIAL REVIEW / ${result.model.name}`, `${result.ok ? 'References checked' : 'Review failed'} · ${(result.elapsedMs / 1000).toFixed(1)} s`,
      result.review?.summary ?? result.error, ...(result.review?.annotations.map(a => `• ${a.entityId}: ${a.comment} [${a.proposedAction}; proposal]`) ?? []),
      'Model interpretation; semantic correctness unverified. Native edits executed: no.', `Evidence: ${result.reportPath}`,
    ].join('\n')); return result.ok ? 0 : 1;
  } catch (e) { out(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : 'Spatial model operation failed.' })); return 1; }
}
