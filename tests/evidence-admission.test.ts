import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { createEvidenceAdmission, type Observation } from '../src/evidence/admission.js';

const observed = (extra: Partial<Observation> = {}): Observation => ({ sourceRevision: 'revision-a', kind: 'native_readback', objectId: 'tray', regionId: 'bore', value: { width: 3, unit: 'mm' }, ...extra });
function session() {
  let revision = 'revision-a';
  const controller = createEvidenceAdmission({ sourceRevision: revision, currentRevision: () => revision,
    fields: { clearance: { kinds: ['native_readback'], objectId: 'tray', regionId: 'bore' } } });
  return { controller, changeRevision: (value: string) => { revision = value; } };
}
function raw(c: ReturnType<typeof session>['controller'], ids: string[], extra = {}) {
  return JSON.stringify({ run_id: c.runId, source_revision: c.sourceRevision, evidence: { clearance: ids }, ...extra });
}
async function ready(extra: Partial<Observation> = {}) {
  const s = session(); const [handle] = await s.controller.observe(async () => [observed(extra)]);
  const cite = s.controller.citationTool().function.execute;
  return { ...s, handle, cite };
}

describe('controller-owned evidence admission', () => {
  it('constrains actual handles and admits only after the SDK cite execute path', async () => {
    const { controller: c, handle, cite } = await ready();
    const text = raw(c, [handle.handle_id]);
    expect(c.outputSchema().safeParse(JSON.parse(text)).success).toBe(true);
    expect(c.outputSchema().safeParse(JSON.parse(raw(c, ['metric_depth']))).success).toBe(false);
    await cite({ handle_id: handle.handle_id }, undefined as never);
    expect(c.admit(text)).toMatchObject({ ok: true, evidence: 'admitted_references', raw_output: text, semantic_correctness_verified: false });
    expect(c.snapshot().citations).toHaveLength(1);
  });
  it('retains uncited refusal and prevents late citation from repairing it', async () => {
    const { controller: c, handle, cite } = await ready(); const text = raw(c, [handle.handle_id]);
    const refusal = c.admit(text);
    expect(refusal).toMatchObject({ ok: false, reason: 'uncited_handle', raw_output: text });
    await expect(cite({ handle_id: handle.handle_id }, undefined as never)).rejects.toThrow('closed');
    expect(c.admit(text)).toMatchObject({ reason: 'run_closed' });
    expect(c.snapshot().decisions[0]).toEqual(refusal);
  });
  it('does not accept model-forged cite success or import records', async () => {
    const { controller: c, handle, cite } = await ready();
    await expect(cite({ handle_id: handle.handle_id, success: true } as never, undefined as never)).rejects.toThrow();
    expect(c.snapshot().citations).toEqual([]);
    expect(c.admit(raw(c, [handle.handle_id], { citations: [{ success: true }] }))).toMatchObject({ reason: 'invalid_output' });
  });
  it('refuses no observations and property labels', async () => {
    const empty = session().controller;
    expect(empty.outputSchema().safeParse(JSON.parse(raw(empty, ['metric_depth']))).success).toBe(false);
    expect(empty.admit(raw(empty, ['metric_depth']))).toMatchObject({ reason: 'no_observations' });
    const { controller: c } = await ready();
    expect(c.admit(raw(c, ['metric_depth']))).toMatchObject({ reason: 'unknown_handle' });
  });
  it('rejects another run, revision and foreign handle', async () => {
    for (const which of ['run', 'revision', 'handle']) {
      const a = await ready(), b = await ready();
      const text = which === 'run' ? raw(a.controller, [a.handle.handle_id], { run_id: b.controller.runId })
        : which === 'revision' ? raw(a.controller, [a.handle.handle_id], { source_revision: 'old' }) : raw(a.controller, [b.handle.handle_id]);
      expect(a.controller.admit(text)).toMatchObject({ reason: which === 'run' ? 'wrong_run' : which === 'revision' ? 'wrong_revision' : 'unknown_handle' });
    }
  });
  it('refuses duplicate handles even after a real citation', async () => {
    const { controller: c, handle, cite } = await ready();
    await cite({ handle_id: handle.handle_id }, undefined as never);
    expect(c.admit(raw(c, [handle.handle_id, handle.handle_id]))).toMatchObject({ reason: 'duplicate_handle' });
  });
  it('rejects wrong evidence tier, object or region', async () => {
    for (const change of [{ kind: 'machine_inference' as const }, { objectId: 'other' }, { regionId: 'other' }]) {
      const { controller: c, handle, cite } = await ready(change);
      await cite({ handle_id: handle.handle_id }, undefined as never);
      expect(c.outputSchema().safeParse(JSON.parse(raw(c, [handle.handle_id]))).success).toBe(false);
      expect(c.admit(raw(c, [handle.handle_id]))).toMatchObject({ reason: 'irrelevant_handle' });
    }
  });
  it('detects changed source before cite and after an in-flight observation', async () => {
    const a = await ready(); a.changeRevision('revision-b');
    await expect(a.cite({ handle_id: a.handle.handle_id }, undefined as never)).rejects.toThrow('stale');
    a.changeRevision('revision-a');
    expect(a.controller.admit(raw(a.controller, [a.handle.handle_id]))).toMatchObject({ reason: 'stale_context' });
    const b = session();
    await expect(b.controller.observe(async () => { b.changeRevision('revision-b'); return [observed()]; })).rejects.toThrow('changed');
    expect(b.controller.snapshot().observations).toEqual([]);
  });
  it('does not observe rejected callbacks or partial invalid batches', async () => {
    const c = session().controller;
    await expect(c.observe(async () => { throw new Error('offline fake failure'); })).rejects.toThrow('fake failure');
    await expect(c.observe(async () => [observed(), observed({ sourceRevision: 'wrong' })])).rejects.toThrow('foreign');
    expect(c.snapshot().observations).toEqual([]);
  });
  it('isolates retained records and raw refusals from external mutation', async () => {
    const { controller: c, handle, cite } = await ready();
    handle.kind = 'machine_inference';
    const result = await cite({ handle_id: handle.handle_id }, undefined as never) as Observation;
    result.value = { changed: true };
    const bad = '  {invalid raw output\n';
    expect(c.admit(bad)).toMatchObject({ reason: 'invalid_output', raw_output: bad });
    const snapshot = c.snapshot(); snapshot.decisions.length = 0;
    expect(c.snapshot().decisions).toHaveLength(1);
    expect(c.snapshot().observations[0]).toMatchObject({ kind: 'native_readback', value: { width: 3, unit: 'mm' } });
  });
  it('cannot expand the registry after exporting the model enum or tool', async () => {
    const { controller: c } = await ready();
    await expect(c.observe(async () => [observed()])).rejects.toThrow('frozen');
    const empty = session().controller; empty.outputSchema();
    await expect(empty.observe(async () => [observed()])).rejects.toThrow('frozen');
  });
  it('refuses duplicate JSON keys without silently replacing invalid evidence', async () => {
    const { controller: c, handle, cite } = await ready();
    await cite({ handle_id: handle.handle_id }, undefined as never);
    const original = raw(c, [handle.handle_id]);
    const text = original.replace('"evidence":', '"evidence":{"clearance":["metric_depth"]},"evidence":');
    expect(c.admit(text)).toMatchObject({ reason: 'invalid_output', raw_output: text });
  });
  it('validates caller-declared payload without changing raw output or importing success', async () => {
    const c = createEvidenceAdmission({ sourceRevision: 'revision-a', currentRevision: () => 'revision-a',
      fields: { clearance: { objectId: 'tray', kinds: ['native_readback'] } }, payloadSchema: z.object({ comment: z.string() }).strict() });
    const [h] = await c.observe(async () => [observed()]);
    await c.citationTool().function.execute({ handle_id: h.handle_id }, undefined as never);
    const text = raw(c, [h.handle_id], { payload: { comment: 'unverified interpretation', success: true } });
    expect(c.admit(text)).toMatchObject({ reason: 'invalid_output', raw_output: text });
  });
  it('explicit execution failure closes a cited run without admitting partial content', async () => {
    const { controller: c, handle, cite } = await ready();
    await cite({ handle_id: handle.handle_id }, undefined as never);
    const text = raw(c, [handle.handle_id]);
    expect(c.refuse(text)).toMatchObject({ ok: false, reason: 'execution_failed', raw_output: text });
    expect(c.admit(text)).toMatchObject({ reason: 'run_closed' });
  });
});
