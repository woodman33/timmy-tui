import { randomUUID } from 'node:crypto';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';

export const evidenceKinds = ['native_readback', 'calibrated_observation', 'deterministic_computation', 'machine_inference', 'generated_hypothesis'] as const;
export type EvidenceKind = typeof evidenceKinds[number];
export interface EvidenceScope { objectId: string; regionId?: string }
export interface EvidenceField extends EvidenceScope { kinds: readonly EvidenceKind[] }
export interface Observation extends EvidenceScope {
  sourceRevision: string;
  kind: EvidenceKind;
  value: unknown;
}
export interface EvidenceHandle extends Observation { handle_id: string; run_id: string }
export type RefusalReason = 'invalid_output' | 'stale_context' | 'wrong_run' | 'wrong_revision' | 'run_closed'
  | 'no_observations' | 'unknown_handle' | 'duplicate_handle' | 'uncited_handle' | 'irrelevant_handle';
export type Admission = {
  ok: false; evidence: 'unknown'; reason: RefusalReason; raw_output: string;
} | {
  ok: true; evidence: 'admitted_references'; raw_output: string;
  run_id: string; source_revision: string; handles: string[];
  semantic_correctness_verified: false;
};

const id = z.string().min(1).max(2048).refine(s => !/[\u0000-\u001f\u007f-\u009f]/.test(s));
const observationSchema = z.object({
  sourceRevision: id, kind: z.enum(evidenceKinds), objectId: id, regionId: id.optional(), value: z.json(),
}).strict();
const fieldSchema = z.object({ objectId: id, regionId: id.optional(), kinds: z.array(z.enum(evidenceKinds)).min(1) }).strict();
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const copy = <T>(value: T): T => structuredClone(value);

// JSON.parse silently keeps the last duplicate property. Do not let that
// erase an invalid earlier evidence field in an otherwise admissible answer.
function duplicateKeys(json: string): boolean {
  const stack: { object: boolean; key: boolean; names: Set<string> }[] = [];
  for (const token of json.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? []) {
    const top = stack.at(-1);
    if (token === '{' || token === '[') stack.push({ object: token === '{', key: token === '{', names: new Set() });
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && top?.object) top.key = true;
    else if (token.startsWith('"') && top?.object && top.key) {
      const name: string = JSON.parse(token);
      if (top.names.has(name)) return true;
      top.names.add(name); top.key = false;
    }
  }
  return false;
}

/**
 * Controller capability, never deserialized from model output. Only trusted
 * adapters may call observe(). A resolved adapter result establishes provenance,
 * not semantic truth; its kind must describe the actual observation tier.
 * currentRevision must read the owner's current source identity, not model input.
 * Use one instance per model run; never share it between turns or source revisions.
 * No persistence/seal or application caller migration is implied by this module.
 */
export function createEvidenceAdmission(options: {
  sourceRevision: string;
  currentRevision: () => string;
  fields: Readonly<Record<string, EvidenceField>>;
}) {
  const sourceRevision = id.parse(options.sourceRevision);
  const currentRevision = options.currentRevision;
  const runId = randomUUID();
  const fields = new Map(Object.entries(options.fields).map(([name, spec]) => [id.parse(name), fieldSchema.parse(spec)]));
  if (!fields.size) throw new Error('At least one declared evidence field is required.');
  const records = new Map<string, EvidenceHandle>();
  const cited = new Set<string>();
  const decisions: Admission[] = [];
  const citations: { handle_id: string; run_id: string; source_revision: string; observed: true }[] = [];
  let stale = false;
  let closed = false;
  let registryFrozen = false;
  function isCurrent() {
    try { if (currentRevision() !== sourceRevision) stale = true; } catch { stale = true; }
    return !stale;
  }
  function relevant(record: Observation, field: EvidenceField) {
    return field.kinds.includes(record.kind) && record.objectId === field.objectId
      && (field.regionId === undefined || record.regionId === field.regionId);
  }
  function allowed(field: EvidenceField) {
    return [...records.values()].filter(record => relevant(record, field)).map(record => record.handle_id);
  }
  function enumSchema(handles: string[]) {
    return handles.length ? z.enum(handles as [string, ...string[]]) : z.never();
  }

  return {
    runId,
    sourceRevision,
    /** Successful observed execution is the only registry insertion path. */
    async observe(execute: () => Promise<readonly Observation[]>): Promise<EvidenceHandle[]> {
      if (closed) throw new Error('Evidence run is closed.');
      if (registryFrozen) throw new Error('Evidence registry is frozen for model tools/schema.');
      if (!isCurrent()) throw new Error('Evidence source revision is stale.');
      const output = await execute();
      if (closed) throw new Error('Evidence run closed during observation.');
      if (registryFrozen) throw new Error('Evidence registry froze during observation.');
      if (!isCurrent()) throw new Error('Evidence source revision changed during observation.');
      if (!Array.isArray(output) || output.length > 1024 || records.size + output.length > 4096)
        throw new Error('Evidence observation limit or shape invalid.');
      // Validate the whole batch before minting anything. Copy the adapter result
      // so later adapter/model mutations cannot alter retained observations.
      const observed = output.map(raw => observationSchema.parse(copy(raw)));
      if (observed.some(record => record.sourceRevision !== sourceRevision))
        throw new Error('Observation names a foreign source revision.');
      const batch = observed.map(record => ({ ...record, handle_id: `ev:${randomUUID()}`, run_id: runId }));
      for (const record of batch) records.set(record.handle_id, record);
      return copy(batch);
    },
    /** Build after observation, then give this schema to the model response API. */
    outputSchema() {
      registryFrozen = true;
      const shape = Object.fromEntries([...fields].map(([name, field]) =>
        [name, z.array(enumSchema(isCurrent() ? allowed(field) : [])).min(1).max(64)]));
      return z.object({ run_id: z.literal(runId), source_revision: z.literal(sourceRevision), evidence: z.object(shape).strict() }).strict();
    },
    /** Actual SDK execute closure; there is no API for importing cite success. */
    citationTool() {
      registryFrozen = true;
      const inputSchema = z.object({ handle_id: enumSchema(isCurrent() ? [...records.keys()] : []) }).strict();
      return tool({
        name: 'cite',
        description: 'Retrieve an observed evidence handle in this run and revision. Citation records provenance only; preserve its evidence kind.',
        inputSchema,
        outputSchema: z.unknown(),
        execute: async (input: unknown) => {
          if (closed) throw new Error('Evidence run is closed.');
          const { handle_id } = inputSchema.parse(input);
          if (!isCurrent()) throw new Error('Evidence source revision is stale.');
          const record = records.get(handle_id);
          if (!record) throw new Error('Evidence handle was not observed.');
          const result = copy(record);
          // No model-supplied success bit or reconstructed tool transcript can
          // add to this controller-owned set. Failed calls never add a citation.
          cited.add(handle_id);
          citations.push({ handle_id, run_id: runId, source_revision: sourceRevision, observed: true });
          return result;
        },
      });
    },
    /** Exact raw response is retained on success and every refusal. */
    admit(raw_output: string): Admission {
      function retain(result: Admission): Admission { decisions.push(copy(result)); return copy(result); }
      function refuse(reason: RefusalReason): Admission { return retain({ ok: false, evidence: 'unknown', reason, raw_output }); }
      if (closed) return refuse('run_closed');
      closed = true;
      if (!isCurrent()) return refuse('stale_context');
      let parsed: unknown;
      try { parsed = JSON.parse(raw_output); } catch { return refuse('invalid_output'); }
      if (duplicateKeys(raw_output)) return refuse('invalid_output');
      const envelope = z.object({ run_id: z.string(), source_revision: z.string(), evidence: z.record(z.string(), z.array(z.string()).min(1).max(64)) }).strict().safeParse(parsed);
      if (!envelope.success) return refuse('invalid_output');
      const output = envelope.data;
      if (output.run_id !== runId) return refuse('wrong_run');
      if (output.source_revision !== sourceRevision) return refuse('wrong_revision');
      if (!records.size) return refuse('no_observations');
      if (Object.keys(output.evidence).length !== fields.size || [...fields.keys()].some(name => !own(output.evidence, name))) return refuse('invalid_output');
      const seen = new Set<string>();
      for (const [name, handles] of Object.entries(output.evidence)) {
        const field = fields.get(name)!;
        for (const handle of handles) {
          if (seen.has(handle)) return refuse('duplicate_handle');
          seen.add(handle);
          const record = records.get(handle);
          if (!record) return refuse('unknown_handle');
          if (!relevant(record, field)) return refuse('irrelevant_handle');
          if (!cited.has(handle)) return refuse('uncited_handle');
        }
      }
      return retain({ ok: true, evidence: 'admitted_references', raw_output, run_id: runId,
        source_revision: sourceRevision, handles: [...seen], semantic_correctness_verified: false });
    },
    snapshot() { return copy({ run_id: runId, source_revision: sourceRevision, observations: [...records.values()], citations, decisions }); },
  };
}
