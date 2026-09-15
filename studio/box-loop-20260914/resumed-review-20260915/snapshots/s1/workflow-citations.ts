import type { LabCallRecord, LabRecord, LabToolDefinition } from './lab-model-adapter.js';

export interface CitationHandle { handle_id: string; revision: unknown; evidenceType: unknown }
/** Only successful observations supplied by the dispatcher can mint selectable handles. */
export function observedCitationHandles(calls: readonly LabCallRecord[]): CitationHandle[] {
  const seen = new Set<string>();
  return calls.flatMap(call => {
    const o = call.output && typeof call.output === 'object' && !Array.isArray(call.output) ? call.output : null;
    if (!call.executed || !call.ok || !o || typeof o.evidenceId !== 'string' || !o.evidenceId || seen.has(o.evidenceId)) return [];
    seen.add(o.evidenceId);
    return [{ handle_id: o.evidenceId, revision: o.revision ?? null, evidenceType: o.evidenceType ?? null }];
  });
}
export function citationTool(handles: readonly CitationHandle[]): LabToolDefinition {
  if (!handles.length) throw Error('No observed citation handles available.');
  return { type: 'function', function: { name: 'cite', description: 'Register an actual observation handle for the final answer. This checks handle identity; the strict task verifier still checks relevance and revision.',
    parameters: { type: 'object', additionalProperties: false, required: ['handle_id'], properties: {
      handle_id: { type: 'string', enum: handles.map(h => h.handle_id) },
    } } } };
}
export function citeObservedHandle(handles: readonly CitationHandle[], args: LabRecord): LabRecord {
  if (Object.keys(args).length !== 1 || typeof args.handle_id !== 'string') throw Error('cite requires only handle_id.');
  const h = handles.find(h => h.handle_id === args.handle_id);
  if (!h) throw Error('Citation is not an observed handle; property names and invented IDs are refused.');
  return { status: 'cited', handle_id: h.handle_id, revision: h.revision as any, evidenceType: h.evidenceType as any };
}
/** A derived request schema, never a rewrite of the task schema or model answer. */
export function constrainCitationSchema(schema: LabRecord | 'json', handles: readonly string[]): LabRecord {
  if (schema === 'json' || !handles.length) throw Error('Citation binding requires an object schema and a successful cite call.');
  const derived: any = structuredClone(schema);
  const citations = derived.properties?.evidenceByFact;
  if (!citations?.properties || citations.type !== 'object') throw Error('Missing evidenceByFact schema.');
  for (const value of Object.values(citations.properties) as any[]) {
    if (value.type !== 'array') throw Error('Citation fields must be arrays.');
    value.items = { type: 'string', enum: [...new Set(handles)] };
  }
  return derived;
}
export function assertCitedFinal(answer: LabRecord | null, handles: readonly string[]): void {
  const byFact = answer?.evidenceByFact;
  if (!byFact || typeof byFact !== 'object' || Array.isArray(byFact)) throw Error('Final citations are missing.');
  for (const ids of Object.values(byFact)) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !handles.includes(id))) throw Error('Final answer cites a handle not accepted by cite.');
  }
}
