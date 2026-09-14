import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { verifySignature } from '../src/utils/receipts.js';
import { digest, retain, seal } from './ctx-c3w8-seal.mjs';

const directory = resolve(process.argv[2] ?? 'studio/ctx-c3w8/checkpoints/C3');
const prediction = JSON.parse(readFileSync(join(directory, 'prediction.json.seal.json'), 'utf8'));
const resultSeal = JSON.parse(readFileSync(join(directory, 'ablation.json.seal.json'), 'utf8'));
const bytes = readFileSync(join(directory, 'ablation.json')), result = JSON.parse(bytes.toString());
if (!verifySignature(prediction) || !verifySignature(resultSeal) || resultSeal.output_sha256 !== digest(bytes)) throw new Error('Timing report requires the sealed completed ablation.');
const elapsedMs = Date.parse(resultSeal.ts) - Date.parse(prediction.ts), withinBudget = elapsedMs <= 900000;
const deadlineFindings = result.rows.filter((r: any) => r.elapsedMs > 155000).map((r: any) => ({ rowId: r.rowId, configuredInferenceTimeoutMs: 150000, observedElapsedMs: r.elapsedMs, error: r.error, cause: 'not-established' }));
const artifact = retain(join(directory, 'checkpoint.json'), {
  schema: 'timmy.ctx-c3w8.c3.checkpoint/1', checkpoint: 'C3', rows: result.rows.length, predictionReceipt: prediction.hash, resultReceipt: resultSeal.hash,
  startedAt: prediction.ts, finishedAt: resultSeal.ts, elapsedMs, budgetSeconds: 900, withinBudget,
  findings: { checkpointBudgetOverrunMs: Math.max(0, elapsedMs - 900000), configuredAbortDidNotEnforceWallClockBound: deadlineFindings },
  modelBlocks: result.blocks, calibration: result.calibration,
  scope: 'Timing and protocol findings retained. Completed all predeclared attempts without retries. Passing individual model-block budgets does not erase the aggregate checkpoint overrun. HOLD was released by the user.',
});
const receipt = seal('ctx.c3.checkpoint', artifact, prediction, withinBudget && deadlineFindings.length === 0 ? 'ok' : 'failed');
console.log(JSON.stringify({ artifact: artifact.path, receipt: receipt.hash, elapsedMs, withinBudget, deadlineFindings }));
