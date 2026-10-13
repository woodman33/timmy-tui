// Model-authored evidence about a Look observation through the mandatory protocol (AGENTS.md §4): the
// measurements are observed handles; the model's answer is admitted only with handles observed in this
// run and revision and successfully cited through the real cite execute closure. The model is a mock.
import { describe, expect, it } from 'vitest';
import { DETERMINISTIC, INTERPRETATION, type LookObservation } from '../src/vision/look.js';
import { qualifyInterpretation, type InterpretationClient, type InterpretationRequest } from '../src/vision/evidence.js';

const SHA = 'ab'.repeat(32);
const OBSERVATION: LookObservation = {
  ok: true,
  worker: { name: 'timmy-look', version: '1.0.0' },
  opencv: '4.10.0',
  python: '3.12',
  source: { path: 'refs/card.png', sha256: SHA, bytes: 2048 },
  image: { width: 640, height: 480, channels: 3 },
  measurements: [
    { name: 'mean_color', value: { r: 10, g: 20, b: 30, hex: '#0a141e' }, unit: 'sRGB 8-bit, uncalibrated', tier: DETERMINISTIC, note: '' },
    { name: 'qr_codes_decoded', value: [{ text: 'CARD-0042', corners: [] }], unit: 'decoded text and corner pixels', tier: DETERMINISTIC, note: '' },
    // Not a deterministic value: it must never become a handle.
    { name: 'depth_guess', value: 0.4, unit: 'm', tier: INTERPRETATION as typeof DETERMINISTIC, note: '' },
  ],
  uncertainty: [],
};

interface Shown { run_id: string; source_revision: string; observations: Array<{ handle_id: string; measurement: string; value: unknown }> }
type Script = (req: InterpretationRequest, shown: Shown, cite: (handle_id: string) => Promise<unknown>) => Promise<string>;

/** A mock model: reads what it was shown, may call the cite tool it was given (as the SDK's tool loop does), then answers. */
function mock(script: Script): { client: InterpretationClient; requests: InterpretationRequest[] } {
  const requests: InterpretationRequest[] = [];
  const client: InterpretationClient = {
    callModel(req) {
      requests.push(req);
      const shown = JSON.parse(typeof req.input === 'string' ? req.input : req.input[0].content.find((c) => c.type === 'input_text')!.text as string) as Shown;
      const cite = (handle_id: string) => req.tools[0].function.execute({ handle_id }, undefined as never);
      return { getText: () => script(req, shown, cite) };
    },
  };
  return { client, requests };
}
const envelope = (shown: Shown, handles: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ run_id: shown.run_id, source_revision: shown.source_revision, evidence: { answer: handles }, payload: { answer: 'The card has a QR code reading CARD-0042.' }, ...extra });
const handleOf = (shown: Shown, name: string): string => shown.observations.find((o) => o.measurement === name)!.handle_id;
const base = { observation: OBSERVATION, question: 'What does the card say?', model: 'test/model', currentRevision: () => SHA };

describe('qualifyInterpretation', () => {
  it('admits an answer whose evidence is handles observed in this run and cited through the cite tool', async () => {
    let raw = '';
    const { client, requests } = mock(async (_req, shown, cite) => {
      await cite(handleOf(shown, 'qr_codes_decoded'));
      raw = envelope(shown, [handleOf(shown, 'qr_codes_decoded')]);
      return raw;
    });
    const q = await qualifyInterpretation({ ...base, client });
    expect(q.asked).toBe(true);
    expect(q.admission).toMatchObject({ ok: true, evidence: 'admitted_references', raw_output: raw, semantic_correctness_verified: false });
    expect(q.answer).toBe('The card has a QR code reading CARD-0042.');
    expect(q.evidence).toMatchObject({ admission: 'admitted_references', source_revision: SHA, raw_output: raw, semantic_correctness_verified: false });
    expect(q.evidence.admission === 'admitted_references' && q.evidence.handles.map((h) => h.measurement)).toEqual(['qr_codes_decoded']);
    expect(q.snapshot.citations).toHaveLength(1);

    // What the model was given: the cite tool, a JSON-schema answer format, and only deterministic values as handles.
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.model).toBe('test/model');
    expect(req.tools.map((t) => t.function.name)).toEqual(['cite']);
    expect(req.text.format.type).toBe('json_schema');
    const shown = JSON.parse(req.input as string) as Shown;
    expect(shown.source_revision).toBe(SHA);
    expect(shown.observations.map((o) => o.measurement)).toEqual(['mean_color', 'qr_codes_decoded']);
    expect(JSON.stringify(req.text.format.schema)).not.toContain('depth_guess');
    for (const o of shown.observations) {
      expect(o.handle_id).toMatch(/^ev:/);
      expect(JSON.stringify(req.text.format.schema)).toContain(o.handle_id);
    }
  });

  it('refuses a handle the model never cited, keeping its raw output', async () => {
    let raw = '';
    const { client } = mock(async (_req, shown) => { raw = envelope(shown, [handleOf(shown, 'mean_color')]); return raw; });
    const q = await qualifyInterpretation({ ...base, client });
    expect(q.admission).toMatchObject({ ok: false, evidence: 'unknown', reason: 'uncited_handle', raw_output: raw });
    expect(q.evidence).toMatchObject({ admission: 'unknown', reason: 'uncited_handle', raw_output: raw });
    expect(q.answer).toBeUndefined();
  });

  it('refuses a handle that was never observed: a property label or a made-up id', async () => {
    for (const fake of ['qr_codes_decoded', 'ev:00000000-0000-4000-8000-000000000000', 'depth_guess']) {
      const { client } = mock(async (_req, shown, cite) => {
        await cite(handleOf(shown, 'qr_codes_decoded'));
        // Citing an unobserved handle fails: the tool's input enum holds only observed handles.
        await expect(cite(fake)).rejects.toThrow();
        return envelope(shown, [fake]);
      });
      const q = await qualifyInterpretation({ ...base, client });
      expect(q.admission).toMatchObject({ ok: false, reason: 'unknown_handle' });
      expect(q.snapshot.citations.map((c) => c.handle_id)).not.toContain(fake);
    }
  });

  it('refuses an answer for another revision or run, and one made while the image changed', async () => {
    const wrongRevision = mock(async (_req, shown, cite) => {
      await cite(handleOf(shown, 'mean_color'));
      return envelope(shown, [handleOf(shown, 'mean_color')], { source_revision: 'cd'.repeat(32) });
    });
    expect((await qualifyInterpretation({ ...base, client: wrongRevision.client })).admission).toMatchObject({ ok: false, reason: 'wrong_revision' });

    const wrongRun = mock(async (_req, shown, cite) => {
      await cite(handleOf(shown, 'mean_color'));
      return envelope(shown, [handleOf(shown, 'mean_color')], { run_id: 'another-run' });
    });
    expect((await qualifyInterpretation({ ...base, client: wrongRun.client })).admission).toMatchObject({ ok: false, reason: 'wrong_run' });

    // The image changes after the handles were observed: a later citation fails, and the answer is stale.
    let now = SHA;
    const changed = mock(async (_req, shown, cite) => {
      now = 'ef'.repeat(32);
      await expect(cite(handleOf(shown, 'mean_color'))).rejects.toThrow('stale');
      return envelope(shown, [handleOf(shown, 'mean_color')]);
    });
    const q = await qualifyInterpretation({ ...base, client: changed.client, currentRevision: () => now });
    expect(q.admission).toMatchObject({ ok: false, reason: 'stale_context' });
    expect(q.evidence).toMatchObject({ admission: 'unknown', reason: 'stale_context' });
  });

  it('a failed exchange is unknown evidence, with what came back preserved', async () => {
    const { client } = mock(async () => { throw new Error('network is off in tests'); });
    const q = await qualifyInterpretation({ ...base, client });
    expect(q.asked).toBe(true);
    expect(q.admission).toMatchObject({ ok: false, evidence: 'unknown', reason: 'execution_failed', raw_output: '' });
    expect(q.error).toMatch(/network is off in tests/);
    // Text that is not the envelope (a refusal to answer) is refused as it is, never rewritten.
    const plain = mock(async () => 'UNKNOWN');
    const r = await qualifyInterpretation({ ...base, client: plain.client });
    expect(r.admission).toMatchObject({ ok: false, reason: 'invalid_output', raw_output: 'UNKNOWN' });
  });

  it('with no deterministic value to cite, the model is not asked and the evidence is unknown', async () => {
    const { client, requests } = mock(async () => 'never');
    const none = { ...OBSERVATION, measurements: OBSERVATION.measurements.filter((m) => m.tier !== DETERMINISTIC) };
    const q = await qualifyInterpretation({ ...base, observation: none, client });
    expect(requests).toHaveLength(0);
    expect(q.asked).toBe(false);
    expect(q.admission).toMatchObject({ ok: false, evidence: 'unknown', reason: 'no_observations', raw_output: '' });
  });

  it('when the image already changed before the run, the model is not asked and the evidence is stale', async () => {
    const { client, requests } = mock(async () => 'never');
    const q = await qualifyInterpretation({ ...base, client, currentRevision: () => 'ef'.repeat(32) });
    expect(requests).toHaveLength(0);
    expect(q.asked).toBe(false);
    expect(q.admission).toMatchObject({ ok: false, evidence: 'unknown', reason: 'stale_context', raw_output: '' });
    expect(q.evidence).toMatchObject({ admission: 'unknown', reason: 'stale_context' });
  });

  it('refuses to start without a question, a model or a Look observation with a sha256', async () => {
    const { client } = mock(async () => 'never');
    await expect(qualifyInterpretation({ ...base, client, question: '  ' })).rejects.toThrow(/question/);
    await expect(qualifyInterpretation({ ...base, client, model: '' })).rejects.toThrow(/model/);
    await expect(qualifyInterpretation({ ...base, client, observation: { ...OBSERVATION, source: { ...OBSERVATION.source, sha256: 'nope' } } })).rejects.toThrow(/sha256/);
  });

  it('sends the image too when it is given, as an input_image beside the text', async () => {
    const { client, requests } = mock(async (_req, shown, cite) => {
      await cite(handleOf(shown, 'mean_color'));
      return envelope(shown, [handleOf(shown, 'mean_color')]);
    });
    const q = await qualifyInterpretation({ ...base, client, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(q.admission.ok).toBe(true);
    const input = requests[0].input;
    expect(Array.isArray(input)).toBe(true);
    if (Array.isArray(input)) expect(input[0].content.map((c) => c.type)).toEqual(['input_text', 'input_image']);
    await expect(qualifyInterpretation({ ...base, client, imageDataUrl: 'https://example.invalid/x.png' })).rejects.toThrow(/data:image/);
  });
});
