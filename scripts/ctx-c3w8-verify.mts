/** Finite, read-only evidence verifier. Embedded signer keys are not trust anchors. */
import { createHash, createPublicKey } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { hashOf, verifySignature, type Receipt } from '../src/utils/receipts.js';
import { validateSpatialModelContext } from '../src/vision/spatial/model-context.js';
import { validateContextPack } from '../src/vision/spatial/context-pack.js';

const HASH = /^[a-f0-9]{64}$/;
const RECEIPT_HASH = /^sha256_[a-f0-9]{64}$/;
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
function requireThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function record(value: any): Record<string, any> { requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Expected an evidence object'); return value; }
function same(a: unknown, b: unknown, message: string) { requireThat(isDeepStrictEqual(a, b), message); }
function date(value: unknown) { requireThat(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'Invalid receipt timestamp'); return Date.parse(value); }

export function verifyReceiptIntegrity(input: unknown): Receipt {
  const r = record(input);
  requireThat(r.v === 1 && r.stream === 'runs' && typeof r.id === 'string' && typeof r.kind === 'string', 'Invalid full receipt');
  requireThat(RECEIPT_HASH.test(r.hash) && (RECEIPT_HASH.test(r.prev_hash) || /^genesis(?:-e\d+)?$/.test(r.prev_hash)), 'Invalid receipt hash fields');
  requireThat(typeof r.signer === 'string' && r.signer.startsWith('-----BEGIN PUBLIC KEY-----') && r.signer.length <= 4096 && typeof r.signature === 'string' && Buffer.from(r.signature, 'base64').length === 64 && Buffer.from(r.signature, 'base64').toString('base64') === r.signature, 'Missing full Ed25519 signature');
  requireThat(createPublicKey(r.signer).asymmetricKeyType === 'ed25519', 'Receipt signer is not Ed25519');
  requireThat(hashOf({ ...r, hash: '' }) === r.hash, 'Receipt self-hash mismatch');
  requireThat(verifySignature(r as Receipt), 'Receipt Ed25519 signature mismatch');
  date(r.ts);
  return r as Receipt;
}

export function safeRelativePath(value: unknown): string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !isAbsolute(value) && !/[\\:\u0000-\u001f]/.test(value), 'Unsafe evidence path');
  requireThat(value.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe evidence path');
  return value;
}

class EvidenceFiles {
  root: string;
  verified = new Set<string>();
  constructor(root: string) { this.root = realpathSync(root); }
  path(path: string) {
    const rel = safeRelativePath(path), lexical = resolve(this.root, rel), canonical = realpathSync(lexical);
    const within = relative(this.root, canonical);
    requireThat(within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within) && canonical === lexical, 'Evidence path traverses symlink or leaves workspace');
    return canonical;
  }
  bytes(path: string, limit = 2 * 1024 * 1024) {
    const fd = openSync(this.path(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      requireThat(before.isFile() && before.size > 0 && before.size <= limit, 'Evidence is empty, oversized or not regular');
      const bytes = Buffer.alloc(before.size + 1); let used = 0;
      while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, null); if (!n) break; used += n; }
      const after = fstatSync(fd);
      requireThat(used === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs, 'Evidence changed while being read');
      return bytes.subarray(0, used);
    } finally { closeSync(fd); }
  }
  json(path: string) { return record(JSON.parse(this.bytes(path).toString('utf8'))); }
  bind(descriptor: any) {
    requireThat(HASH.test(descriptor?.sha256), 'Invalid artifact digest');
    const bytes = this.bytes(descriptor.path, 128 * 1024 * 1024);
    requireThat(digest(bytes) === descriptor.sha256, `Artifact hash mismatch: ${descriptor.path}`);
    if (descriptor.bytes !== undefined) requireThat(Number.isSafeInteger(descriptor.bytes) && descriptor.bytes === bytes.length, `Artifact byte count mismatch: ${descriptor.path}`);
    this.verified.add(descriptor.path);
    return bytes;
  }
  walk(directory: string) {
    const files: string[] = [];
    const visit = (path: string, depth: number) => {
      requireThat(depth <= 12 && files.length <= 4096, 'Evidence inventory exceeds bounds');
      const absolute = this.path(path), stat = lstatSync(absolute);
      if (stat.isDirectory()) for (const name of readdirSync(absolute).sort()) visit(path + '/' + name, depth + 1);
      else { requireThat(stat.isFile(), 'Nonregular evidence entry'); files.push(path); }
    };
    visit(safeRelativePath(directory), 0); return files;
  }
}

const requiredFacts: Record<string, string> = { knownLocations: 'volume.location-count', totalCells: 'volume.total-cells', empty: 'volume.fill-coverage', partial: 'volume.fill-coverage', full: 'volume.fill-coverage', centerXmm: 'cell-center.location', centerYmm: 'cell-center.location', centerZmm: 'cell-center.location', fillFraction: 'cell-center.fill', material: 'volume.material', densityKgM3: 'volume.density', massKg: 'volume.density' };
const failedScore = (error: string) => ({ valid: false, correct: false, referencesValid: false, groundedCorrect: 0, unknownsPreserved: 0, score: 0, answerCoverage: 0, error });

/** Recompute the frozen rubric independently of the execution scorer. */
export function recomputeScore(row: any, rubric: any, context: any) {
  if (row.error) return failedScore(row.error);
  const raw = row.raw;
  const keys = (o: any, expected: string[]) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => expected.includes(k)) && expected.every(k => Object.hasOwn(o, k));
  if (!keys(raw, ['answers', 'unknowns']) || !Array.isArray(raw.answers) || raw.answers.length > 5 || !Array.isArray(raw.unknowns) || raw.unknowns.length > 3 || raw.unknowns.some((x: any) => !['material', 'density', 'mass'].includes(x)) || raw.answers.some((a: any) => !keys(a, ['key', 'value', 'entityId', 'factIds']) || typeof a.key !== 'string' || a.key.length > 40 || !(a.value === null || typeof a.value === 'number' && Number.isFinite(a.value) || typeof a.value === 'string' && a.value.length <= 100) || !(a.entityId === null || typeof a.entityId === 'string' && a.entityId.length <= 128) || !Array.isArray(a.factIds) || a.factIds.length > 5 || a.factIds.some((id: any) => typeof id !== 'string' || id.length > 128))) return failedScore('Output schema rejected.');
  const expected = record(rubric[row.questionId]);
  const answers = new Map<string, any>(raw.answers.map((a: any) => [a.key, a]));
  if (answers.size !== raw.answers.length || answers.size !== Object.keys(expected).length || !Object.keys(expected).every(k => answers.has(k))) return failedScore('Missing, duplicate or unexpected answer keys.');
  const correct = Object.entries(expected).every(([key, value]) => value === null ? answers.get(key).value === null : typeof answers.get(key).value === 'number' && Math.abs(answers.get(key).value - value) <= rubric.absoluteTolerance);
  const facts = new Map<string, any>(context.facts.map((f: any) => [f.id, f]));
  const referencesValid = raw.answers.every((a: any) => row.condition === 'no-pack'
    ? a.value === null && a.entityId === null && a.factIds.length === 0
    : a.entityId === (row.questionId === 'center' ? 'cell-center' : 'volume') && a.factIds.length > 0 && a.factIds.every((id: string) => facts.get(id)?.entityId === a.entityId) && a.factIds.includes(requiredFacts[a.key]));
  const groundedCorrect = Number(correct && referencesValid), unknownsPreserved = Number(new Set(raw.unknowns).size === 3 && (row.questionId !== 'physical' || raw.answers.every((a: any) => a.value === null)));
  return { valid: true, correct, referencesValid, groundedCorrect, unknownsPreserved, score: groundedCorrect + unknownsPreserved, answerCoverage: raw.answers.filter((a: any) => a.value !== null).length / raw.answers.length, error: null };
}

export function verifyEvidence(workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..'), study = 'studio/ctx-c3w8') {
  const fs = new EvidenceFiles(workspace), inventory = fs.walk(study);
  const receipts = new Map<string, Receipt>(), receiptArtifacts = new Map<string, string>();
  const addReceipt = (input: any) => {
    const r = verifyReceiptIntegrity(input), previous = receipts.get(r.hash);
    if (previous) { same(previous, r, 'Conflicting duplicate receipt'); return r; }
    requireThat(Array.isArray(r.artifacts) && r.artifacts.length === 1, 'Expected one explicitly bound artifact per checkpoint receipt');
    const hash = r.output_sha256 ?? (r.kind === 'ctx.c1.predict' ? r.prompt_hash : undefined);
    requireThat(typeof hash === 'string' && HASH.test(hash), 'Receipt lacks its artifact hash');
    fs.bind({ path: r.artifacts[0], sha256: hash });
    receipts.set(r.hash, r); receiptArtifacts.set(r.hash, r.artifacts[0]); return r;
  };
  for (const path of inventory) {
    if (path.endsWith('.seal.json') || path.endsWith('.receipt.json')) addReceipt(fs.json(path));
    else if (path.endsWith('.descriptor.json')) {
      const d = fs.json(path), r = addReceipt(d.receipt), bytes = fs.bind(d.artifact);
      requireThat(r.artifacts?.includes(d.artifact.path) && r.output_sha256 === d.artifact.sha256, 'Descriptor receipt does not bind its artifact');
      if (d.result !== undefined) same(d.result, JSON.parse(bytes.toString()), 'Descriptor result differs from retained artifact');
    }
  }
  const one = (kind: string) => { const matches = [...receipts.values()].filter(r => r.kind === kind); requireThat(matches.length === 1, `Expected exactly one ${kind} receipt`); return matches[0]; };
  const byHash = (hash: string) => { const r = receipts.get(hash); requireThat(r, 'Missing referenced receipt: ' + hash); return r; };
  const body = (r: Receipt) => fs.json(receiptArtifacts.get(r.hash)!);
  const before = (a: Receipt, b: Receipt) => requireThat(date(a.ts) < date(b.ts), `Prediction/intent must precede result: ${a.kind} → ${b.kind}`);
  const bracket = (prediction: Receipt, checkpoint: Receipt, children: Receipt[]) => {
    before(prediction, checkpoint); requireThat(checkpoint.plan_hash === prediction.hash, 'Checkpoint lost prediction binding');
    for (const child of children) { before(prediction, child); requireThat(date(child.ts) <= date(checkpoint.ts), 'Child result follows its checkpoint'); }
    const p = body(prediction); if (p.createdAt) requireThat(date(p.createdAt) <= date(prediction.ts), 'Prediction creation follows its seal');
  };
  let externalPreviousLinks = 0;
  for (const r of receipts.values()) {
    if (receipts.has(r.prev_hash)) { const prev = byHash(r.prev_hash); requireThat(date(prev.ts) <= date(r.ts) && prev.epoch === r.epoch, 'Retained previous-receipt ordering/epoch mismatch'); }
    else if (!r.prev_hash.startsWith('genesis')) externalPreviousLinks++;
    if (r.plan_hash) { const parent = byHash(r.plan_hash); requireThat(date(parent.ts) <= date(r.ts), 'Plan receipt follows child'); }
    for (const child of r.child_receipts ?? []) { const c = byHash(child); requireThat(date(c.ts) <= date(r.ts), 'Child receipt follows parent summary'); }
  }

  const c1p = one('ctx.c1.predict'), c1 = one('ctx.c1.checkpoint'), c1body = body(c1);
  bracket(c1p, c1, [one('ctx.c1.negative-control'), one('ctx.c1.finding')]);
  requireThat(c1.status === 'ok' && c1body.ok === true && Object.values(c1body.checks).every(x => x === true), 'C1 did not pass its controls');
  for (const artifact of c1body.artifacts) fs.bind(artifact);
  requireThat(c1body.limits?.realModelInferenceCalls === 0 && c1body.limits?.daemonOsEgress === 'unmeasured' && c1body.limits?.wholeMachineAirgap === 'not-established', 'C1 boundary changed');

  const c2p = one('ctx.c2.prediction'), c2 = one('ctx.c2.checkpoint'), c2body = body(c2);
  const packReceipt = byHash(c2body.packReceipt), validAnnotation = byHash(c2body.validAnnotationReceipt), negativeAnnotation = byHash(c2body.negativeControlReceipt);
  requireThat(c2.status === 'ok', 'C2 checkpoint failed');
  bracket(c2p, c2, [packReceipt, validAnnotation, negativeAnnotation]);
  const pack = validateContextPack(JSON.parse(fs.bind(c2body.pack).toString())); fs.bind(c2body.descriptor); fs.bind(c2body.graniteFixture);
  const sourceManifest = JSON.parse(fs.bind(pack.document).toString());
  for (const artifact of Object.values(record(sourceManifest.artifacts))) fs.bind({ ...record(artifact), path: dirname(pack.document.path) + '/' + safeRelativePath((artifact as any).path) });
  requireThat(packReceipt.kind === 'context.pack' && packReceipt.output_sha256 === c2body.pack.sha256, 'C2 pack receipt mismatch');
  requireThat(body(validAnnotation).status === 'grounded' && body(negativeAnnotation).reason === 'annotation_ungrounded' && body(negativeAnnotation).annotations.length === 0, 'C2 annotation control mismatch');
  for (const r of [validAnnotation, negativeAnnotation]) { const a = body(r); requireThat(a.packSha256 === c2body.pack.sha256 && a.sourceRevision === pack.sourceRevision && a.scope.semanticCorrectnessChecked === false && a.scope.nativeEditsExecuted === false, 'C2 annotation boundary mismatch'); }

  const c4p = one('ctx.c4.prediction'), c4 = one('ctx.c4.checkpoint'), c4body = body(c4);
  requireThat(c4.status === 'ok', 'C4 checkpoint failed');
  const fresh = byHash(c4body.freshReceipt), stale = byHash(c4body.staleReceipt);
  const c4packs = [...receipts.values()].filter(r => r.kind === 'context.pack' && r.output_sha256 === c4body.fresh.packSha256 && receiptArtifacts.get(r.hash)?.startsWith(study + '/checkpoints/C4/'));
  requireThat(c4packs.length === 1 && c4body.fresh.packSha256 === c4body.stale.packSha256, 'C4 pack binding mismatch');
  const c4pack = validateContextPack(body(c4packs[0])); requireThat(c4pack.sourceRevision === pack.sourceRevision, 'C4 source pack differs from C2 fixture');
  bracket(c4p, c4, [c4packs[0], fresh, stale]); same(c4body.fresh, body(fresh), 'C4 fresh result mismatch'); same(c4body.stale, body(stale), 'C4 stale result mismatch');
  requireThat(c4body.fresh.status === 'proposed' && c4body.stale.reason === 'stale_source_revision' && c4body.sourceRevision === pack.sourceRevision && c4body.fresh.dryRun.documentWritten === false && c4body.stale.dryRun.documentWritten === false && c4body.checks.proposalDocumentWrites === 0, 'C4 proposal/refusal boundary mismatch');
  fs.bind({ path: c4body.stale.document.path, sha256: c4body.harnessAdvancedRevision });

  const c3dir = study + '/checkpoints/C3', predictionReceipt = one('context.ablation.prediction'), prediction = body(predictionReceipt);
  const ablationReceipt = one('context.ablation'), ablation = body(ablationReceipt), calibrationReceipt = one('context.calibration'), calibration = body(calibrationReceipt);
  requireThat(ablationReceipt.status === 'ok' && calibrationReceipt.status === 'ok', 'C3 summary/calibration failed');
  before(predictionReceipt, ablationReceipt); before(ablationReceipt, calibrationReceipt);
  requireThat(predictionReceipt.plan_hash === packReceipt.hash && ablationReceipt.plan_hash === predictionReceipt.hash && calibrationReceipt.plan_hash === ablationReceipt.hash, 'C3 summary lineage mismatch');
  requireThat(date(prediction.createdAt) <= date(predictionReceipt.ts), 'C3 prediction created after seal');
  const contextBytes = fs.bytes(c3dir + '/context.json'), context = validateSpatialModelContext(JSON.parse(contextBytes.toString()));
  same(context, pack.context, 'C3 context differs from sealed C2 pack');
  for (const item of [prediction, ablation]) requireThat(item.contextSha256 === digest(contextBytes) && item.contextPackSha256 === c2body.pack.sha256 && item.sourceSha256 === context.source.sha256, 'C3 source/context binding mismatch');
  for (const source of prediction.code) fs.bind(source);
  requireThat(prediction.rubric.version === 'ctx-c3w8/1' && prediction.rubric.absoluteTolerance === 1e-6, 'Unsupported frozen rubric');
  const facts = new Map<string, any>(context.facts.map(f => [f.id, f]));
  same(prediction.rubric.counts, { knownLocations: facts.get('volume.location-count').value, totalCells: facts.get('volume.total-cells').value, ...Object.fromEntries(['empty', 'partial', 'full'].map(k => [k, facts.get('volume.fill-coverage').value[k]])) }, 'Frozen count rubric differs from context');
  const center = facts.get('cell-center.location').value;
  same(prediction.rubric.center, { centerXmm: center[0], centerYmm: center[1], centerZmm: center[2], fillFraction: facts.get('cell-center.fill').value }, 'Frozen center rubric differs from context');
  same(prediction.rubric.physical, { material: null, densityKgM3: null, massKg: null }, 'Physical unknown rubric changed');
  requireThat(['volume.material', 'volume.density'].every(id => facts.get(id)?.epistemic === 'unknown'), 'Physical unknown source changed');
  requireThat(prediction.models.length === 4 && new Set(prediction.models.map((m: any) => m.name)).size === 4 && prediction.questions.length === 3 && new Set(prediction.questions.map((q: any) => q.id)).size === 3, 'Frozen model/question inventory differs');
  same(prediction.models.map((m: any) => [m.requested, m.name]), [['granite4.2', 'granite4.2:latest'], ['ornith', 'ornith:latest'], ['gemma4:12b', 'gemma4:12b-it-qat'], ['qwen3.8:27b-mlx', 'qwen3.8:27b-mlx']], 'ORDER model selection changed');
  same(prediction.questions.map((q: any) => q.id), ['counts', 'center', 'physical'], 'ORDER question inventory changed');
  same(prediction.conditions, ['no-pack', 'pack'], 'Frozen conditions changed');
  requireThat(prediction.expected.rows === 24 && Array.isArray(ablation.rows) && ablation.rows.length === 24, 'C3 requires exactly 24 retained rows');
  const expected = new Set<string>(), seen = new Set<string>(), seenIds = new Set<string>();
  for (const m of prediction.models) for (const q of prediction.questions) for (const condition of prediction.conditions) expected.add(`${m.name}|${q.id}|${condition}`);
  const rowReceipts = [...receipts.values()].filter(r => r.kind === 'context.ablation.result');
  const intentReceipts = [...receipts.values()].filter(r => r.kind === 'context.ablation.intent');
  requireThat(rowReceipts.length === 24 && intentReceipts.length === 24, 'Unexpected missing or repeated C3 attempts');
  for (const row of ablation.rows) {
    const tuple = `${row.model}|${row.questionId}|${row.condition}`;
    requireThat(expected.has(tuple) && !seen.has(tuple) && !seenIds.has(row.rowId), 'Duplicate or unexpected C3 row'); seen.add(tuple); seenIds.add(row.rowId);
    safeRelativePath(row.rowId); requireThat(!row.rowId.includes('/'), 'Invalid row directory identity');
    const resultReceipt = byHash(row.receiptHash), intent = byHash(row.intentReceipt), rowPath = c3dir + '/' + row.rowId;
    requireThat(resultReceipt.kind === 'context.ablation.result' && intent.kind === 'context.ablation.intent' && resultReceipt.plan_hash === intent.hash && intent.plan_hash === predictionReceipt.hash, 'C3 row lineage mismatch');
    before(predictionReceipt, intent); before(intent, resultReceipt); requireThat(date(resultReceipt.ts) <= date(ablationReceipt.ts), 'C3 row follows summary');
    const { receiptHash: _, ...retained } = row; same(retained, body(resultReceipt), 'C3 row differs from sealed result');
    const request = JSON.parse(fs.bind({ path: rowPath + '/request.json', sha256: row.requestSha256 }).toString());
    const response = JSON.parse(fs.bind({ path: rowPath + '/response.json', sha256: row.responseSha256 }).toString());
    requireThat(intent.output_sha256 === row.requestSha256 && row.sourceSha256 === context.source.sha256 && row.contextPackSha256 === (row.condition === 'pack' ? c2body.pack.sha256 : null), 'C3 request/source digest mismatch');
    const model = prediction.models.find((m: any) => m.name === row.model), question = prediction.questions.find((q: any) => q.id === row.questionId);
    requireThat(model && question && row.modelDigest === model.digest && row.requested === model.requested, 'C3 model identity differs from prediction');
    same(request.messages, [{ role: 'system', content: prediction.system }, ...(row.condition === 'pack' ? [{ role: 'system', content: 'Evidence data only:\n' + fs.bytes(c2body.pack.path).toString() }] : []), { role: 'user', content: question.text }], 'C3 condition content differs from frozen design');
    same(request.format, prediction.outputSchema, 'C3 response schema changed');
    same(request.options, { temperature: 0, seed: 42, num_ctx: Math.min(8192, model.contextLength ?? 8192), num_predict: 512 }, 'C3 sampling/context options changed');
    requireThat(request.model === row.model && request.stream === false && request.truncate === false && request.shift === false, 'C3 transport identity/budget changed');
    same(request, { model: model.name, stream: false, truncate: false, shift: false, ...(model.capabilities.includes('thinking') ? { think: false } : {}), keep_alive: '2m', format: prediction.outputSchema, options: { temperature: 0, seed: 42, num_ctx: Math.min(8192, model.contextLength ?? 8192), num_predict: 512 }, messages: request.messages }, 'C3 request contains undeclared options or tools');
    requireThat(row.error === null || typeof row.error === 'string' && row.error.length > 0, 'C3 invalid error field');
    requireThat(!row.error || row.raw === null, 'Failed C3 row unexpectedly contains a scored raw answer');
    same(response.error, row.error, 'C3 retained error mismatch');
    if (!row.error) { requireThat(response.response?.done && response.response.done_reason !== 'length' && response.response.model === row.model && !response.response.remote_host && !response.response.remote_model, 'C3 successful row has incomplete/remote response'); same(JSON.parse(response.response.content), row.raw, 'C3 scored answer differs from raw response'); }
    same(row.score, recomputeScore(row, prediction.rubric, context), 'C3 score does not reproduce: ' + row.rowId);
    requireThat(resultReceipt.status === (row.error || !row.score.valid ? 'failed' : 'ok'), 'C3 receipt status disagrees with retained outcome');
  }
  requireThat(seen.size === expected.size, 'Incomplete C3 matrix');
  const recomputed = prediction.models.map((model: any) => {
    const stats = (condition: string) => {
      const rows = ablation.rows.filter((r: any) => r.model === model.name && r.condition === condition);
      const mean = (key: string) => rows.reduce((sum: number, r: any) => sum + Number(r.score[key]), 0) / rows.length;
      return { count: rows.length, failed: rows.filter((r: any) => r.error || !r.score.valid).length, meanScore: mean('score'), groundedCorrectRate: mean('groundedCorrect'), unknownsPreservedRate: mean('unknownsPreserved'), meanAnswerCoverage: mean('answerCoverage') };
    };
    const noPack = stats('no-pack'), withPack = stats('pack'), predicted = prediction.expected.contextLiftDirectionPerModel.find((m: any) => m.model === model.name).meanScoreLift;
    return { model: model.name, modelDigest: model.digest, noPack, withPack, contextLift: withPack.meanScore - noPack.meanScore, prediction: predicted, predictionError: withPack.meanScore - noPack.meanScore - predicted };
  });
  same(recomputed, ablation.calibration, 'C3 aggregate calibration does not reproduce'); same(recomputed, calibration.models, 'Calibration artifact differs from recomputed scores');
  requireThat(calibration.resultReceipt === ablationReceipt.hash && calibration.predictionReceipt === predictionReceipt.hash && ablation.predictionReceipt === predictionReceipt.hash, 'Calibration receipt joins disagree');

  const c3 = one('ctx.c3.checkpoint'), c3body = body(c3);
  bracket(predictionReceipt, c3, [ablationReceipt, calibrationReceipt]);
  requireThat(c3body.schema === 'timmy.ctx-c3w8.c3.checkpoint/1' && c3body.checkpoint === 'C3' && c3body.rows === 24 && c3body.predictionReceipt === predictionReceipt.hash && c3body.resultReceipt === ablationReceipt.hash, 'C3 timing checkpoint joins disagree');
  const elapsedMs = date(ablationReceipt.ts) - date(predictionReceipt.ts), budgetMs = 900000;
  requireThat(c3body.startedAt === predictionReceipt.ts && c3body.finishedAt === ablationReceipt.ts && c3body.elapsedMs === elapsedMs && c3body.budgetSeconds === budgetMs / 1000 && c3body.withinBudget === (elapsedMs <= budgetMs), 'C3 aggregate timing/budget does not reproduce');
  requireThat(prediction.options.timeoutMs === 150000 && ablation.rows.every((r: any) => Number.isSafeInteger(r.elapsedMs) && r.elapsedMs >= 0), 'C3 request timing inputs invalid');
  // The retained row duration includes the metadata check (up to 5s); its
  // overrun does not independently establish where or why cancellation lagged.
  const deadlineFindings = ablation.rows.filter((r: any) => r.elapsedMs > 155000).map((r: any) => ({ rowId: r.rowId, configuredInferenceTimeoutMs: 150000, observedElapsedMs: r.elapsedMs, error: r.error, cause: 'not-established' }));
  same(c3body.findings, { checkpointBudgetOverrunMs: Math.max(0, elapsedMs - budgetMs), configuredAbortDidNotEnforceWallClockBound: deadlineFindings }, 'C3 timing findings do not reproduce');
  same(c3body.modelBlocks, ablation.blocks, 'C3 timing model blocks differ'); same(c3body.calibration, recomputed, 'C3 timing calibration differs');
  requireThat(c3.status === (elapsedMs <= budgetMs && deadlineFindings.length === 0 ? 'ok' : 'failed'), 'C3 checkpoint receipt hides a timing failure');
  const observedFindings = [
    ...(elapsedMs > budgetMs ? [{ checkpoint: 'C3', code: 'checkpoint_budget_overrun', elapsedMs, budgetMs, overrunMs: elapsedMs - budgetMs }] : []),
    ...deadlineFindings.map((finding: any) => ({ checkpoint: 'C3', code: 'configured_deadline_exceeded', ...finding, scope: 'Observed total row elapsed time; cancellation-delay cause is not established.' })),
  ];

  const c5p = one('ctx.c5.prediction'), c5 = one('ctx.c5.checkpoint');
  requireThat(c5.status === 'ok', 'C5 checkpoint failed');
  const exportPath = study + '/checkpoints/C5/exports/export-manifest.json', exportSeal = addReceipt(fs.json(exportPath + '.seal.json')), exported = fs.json(exportPath);
  bracket(c5p, c5, [exportSeal]);
  requireThat(exportSeal.output_sha256 === digest(fs.bytes(exportPath)) && exported.sourceSha256 === context.source.sha256 && exported.contextSha256 === digest(contextBytes) && exported.ablationSha256 === ablationReceipt.output_sha256, 'C5 source/export binding mismatch');
  requireThat(exported.schema === 'timmy.spatial-context-export/1' && exported.scope.nativeEditsExecuted === false && exported.scope.semanticCorrectnessChecked === false, 'C5 scope changed');
  same(exported.sourceArtifacts, sourceManifest.artifacts, 'C5 source artifact inventory differs');
  requireThat(exported.geometry?.gridLocations === facts.get('volume.total-cells').value, 'C5 location inventory differs from context');
  for (const [name, descriptor] of Object.entries(exported.files)) fs.bind({ ...record(descriptor), path: study + '/checkpoints/C5/exports/' + safeRelativePath(name) });
  requireThat(exported.files['context.rrd'] && exported.files['context.viser'] && exported.rerun.exitCode === 0 && exported.viser.annotationRows === 24, 'C5 native export evidence incomplete');
  same(digest(fs.bytes(study + '/checkpoints/C5/exports/input-context.json')), digest(contextBytes), 'C5 retained context differs');
  same(digest(fs.bytes(study + '/checkpoints/C5/exports/input-ablation.json')), ablationReceipt.output_sha256, 'C5 retained ablation differs');
  same(digest(fs.bytes(study + '/checkpoints/C5/exports/input-manifest.json')), context.source.sha256, 'C5 retained source differs');

  return { ok: true, order: 'ctx-c3w8', checkpoints: ['C1', 'C2', 'C3', 'C4', 'C5'], checkpointStatuses: { C1: c1.status, C2: c2.status, C3: c3.status, C4: c4.status, C5: c5.status }, allCheckpointsMetCriteria: [c1, c2, c3, c4, c5].every(r => r.status === 'ok'), observedFindings, uniqueReceipts: receipts.size, verifiedArtifactFiles: fs.verified.size, ablationRows: seen.size, calibrationRecomputed: true, exports: { rerun: exported.files['context.rrd'], viser: exported.files['context.viser'] }, externalPreviousLinks, signerFingerprints: [...new Set([...receipts.values()].map(r => digest(r.signer!)))], scope: { completeChainVerified: false, embeddedKeysExternallyTrusted: false, trustedClockVerified: false, semanticTruthValidated: false, physicalValidation: false, nativeV3Validated: false, meaning: 'ok reports retained evidence integrity, not that checkpoint acceptance criteria passed. Checks cover artifact joins, timestamp ordering and frozen-rubric arithmetic; external previous-chain links remain external.' } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(verifyEvidence(process.argv[2], process.argv[3]))); }
  catch (error) { console.log(JSON.stringify({ ok: false, order: 'ctx-c3w8', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
}
