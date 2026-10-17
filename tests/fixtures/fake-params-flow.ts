/**
 * R6 (H144): a FAKE flow for the run inspection's tests: a TEST DOUBLE of what `timmy act '/iterate tray "…"'` leaves in a
 * project when its agent changes the tray's parameter file. No agent runs and nothing is built. It:
 *   - keeps the parameter file's bytes as read in the flow's own folder (.timmy/flows/<id>/params.before.json), as /iterate
 *     keeps them for /review and /restore;
 *   - writes the new width into recipes/tray.params.json;
 *   - writes the flow record through Timmy's own writer (src/flows/iterate.ts writeFlowRecord), naming the file's sha256
 *     before and after and the kept copy;
 *   - seals a flow receipt on the project's real runs chain naming the record's bytes, under the operation its caller gives
 *     (TIMMY_OPERATION, which a workflow block's job carries), as the flow's own seal names the operation `timmy act` joined.
 *
 * Used two ways: imported (fakeParamsFlow), or run as a command from a workflow block, in the project's folder:
 *   fake-params-flow <width>
 * which seals on the store `timmy act` would use there (TIMMY_STORE).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FLOW_SCHEMA, newFlowId, writeFlowRecord, type FlowRecord } from '../../src/flows/iterate.js';
import { projectId } from '../../src/project/index.js';
import { DOCTRINE_15, RECIPE_ID } from '../../src/recipes/index.js';
import { appendReceipt } from '../../src/utils/receipts.js';

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
export const PARAMS = 'recipes/tray.params.json';

/** The FAKE flow: the width changed in recipes/tray.params.json, the bytes before kept, its record written and sealed. */
export function fakeParamsFlow(root: string, width: number, o: { operation?: string; dir?: string } = {}): { id: string; rel: string; kept: string; receipt: string; before: string; after: string } {
  const id = newFlowId();
  const file = path.join(root, PARAMS);
  const beforeBytes = fs.readFileSync(file);
  const before = JSON.parse(beforeBytes.toString('utf8')) as { parameters: Record<string, number> };
  const kept = `.timmy/flows/${id}/params.before.json`;
  fs.mkdirSync(path.join(root, path.dirname(kept)), { recursive: true });
  fs.writeFileSync(path.join(root, kept), beforeBytes, { mode: 0o444 });
  const afterValues = { ...before.parameters, width };
  const afterText = `${JSON.stringify({ ...before, parameters: afterValues }, null, 2)}\n`;
  fs.writeFileSync(file, afterText);
  const now = new Date().toISOString();
  const record: FlowRecord = {
    flow: 1, schema: FLOW_SCHEMA, id, kind: 'iterate', recipe: RECIPE_ID,
    instruction: `FAKE: make the tray ${width} mm wide`, project: path.basename(root),
    ...(o.operation ? { operation: o.operation } : {}),
    started_at: now, ended_at: now, outcome: 'succeeded', why: `FAKE: the width set to ${width} (a test double: no agent ran, nothing was built)`,
    parameters: { path: PARAMS, created: false, before: { sha256: sha(beforeBytes), values: before.parameters, kept }, after: { sha256: sha(afterText), values: afterValues } },
    receipts: {}, child_receipts: [], doctrine: DOCTRINE_15,
  };
  const w = writeFlowRecord(root, record);
  if (!w.ok) throw new Error(`FAKE flow record not written: ${w.error}`);
  const r = appendReceipt('runs', {
    kind: 'flow', subject: `flow · iterate · tray · ${id} · succeeded (FAKE)`, policy: 'human-gated', status: 'ok',
    project: record.project, project_id: projectId(root), ...(o.operation ? { operation_id: o.operation } : {}),
    outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }],
  }, o.dir);
  return { id, rel: w.path, kept, receipt: r.hash.slice(7, 15), before: sha(beforeBytes), after: sha(afterText) };
}

const main = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (main) {
  const width = Number(process.argv[2] ?? '150');
  const op = process.env.TIMMY_OPERATION?.trim();
  const root = fs.realpathSync(process.cwd());
  const f = fakeParamsFlow(root, width, op ? { operation: op } : {});
  console.log(`FAKE flow ${f.id}: ${PARAMS} width ${width} (kept ${f.kept}; receipt ${f.receipt})`);
}
