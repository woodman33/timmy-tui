import { z } from 'zod';
import type { SpatialModelContext } from './model-context.js';

export const ABLATION_MODELS = [
  { requested: 'granite4.2', installed: 'granite4.2:latest' },
  { requested: 'ornith', installed: 'ornith:latest' },
  { requested: 'gemma4:12b', installed: 'gemma4:12b-it-qat' },
  { requested: 'qwen3.8:27b-mlx', installed: 'qwen3.8:27b-mlx' },
] as const;
export const ABLATION_QUESTIONS = [
  { id: 'counts', text: 'For the selected volume, report knownLocations, totalCells, empty, partial and full cell counts.' },
  { id: 'center', text: 'For the selected center-index voxel, report centerXmm, centerYmm, centerZmm and fillFraction.' },
  { id: 'physical', text: 'For the selected volume, report physical material identity as material, intrinsic density as densityKgM3, and total physical mass as massKg.' },
] as const;
export type QuestionId = typeof ABLATION_QUESTIONS[number]['id'];
export const ABLATION_RUBRIC = {
  version: 'ctx-c3w8/1', absoluteTolerance: 1e-6,
  counts: { knownLocations: 1000, totalCells: 1000, empty: 488, partial: 96, full: 416 },
  center: { centerXmm: 5, centerYmm: 5, centerZmm: 5, fillFraction: 0.046875 },
  physical: { material: null, densityKgM3: null, massKg: null },
  score: 'groundedCorrect (0 or 1) + unknownsPreserved (0 or 1)',
  grounding: 'Numeric answers require correct source-bound facts for the right entity. With no pack, null physical answers with no invented citations are valid abstention. Unknown mass follows from unknown intrinsic density; fill is not density.',
  failures: 'Retained as failed rows with score 0; no automatic retries or dropped rows.',
  limits: 'One deterministic generated fixture, one trial per cell, fixed model order; no significance or universal vision claim. Correctness, answer coverage and unknown preservation reported separately. Pack adds task information by design.',
} as const;
export const ablationResponseSchema = z.object({
  answers: z.array(z.object({ key: z.string().max(40), value: z.union([z.number().finite(), z.string().max(100), z.null()]), entityId: z.string().max(128).nullable(), factIds: z.array(z.string().max(128)).max(5) }).strict()).max(5),
  unknowns: z.array(z.enum(['material', 'density', 'mass'])).max(3),
}).strict();
export const ABLATION_FORMAT = { type: 'object', additionalProperties: false, properties: {
  answers: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, properties: {
    key: { type: 'string' }, value: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
    entityId: { anyOf: [{ type: 'string' }, { type: 'null' }] }, factIds: { type: 'array', maxItems: 5, items: { type: 'string' } },
  }, required: ['key', 'value', 'entityId', 'factIds'] } },
  unknowns: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['material', 'density', 'mass'] } },
}, required: ['answers', 'unknowns'] };
const references: Record<string, string[]> = {
  knownLocations: ['volume.location-count'], totalCells: ['volume.total-cells'],
  empty: ['volume.fill-coverage'], partial: ['volume.fill-coverage'], full: ['volume.fill-coverage'],
  centerXmm: ['cell-center.location'], centerYmm: ['cell-center.location'], centerZmm: ['cell-center.location'], fillFraction: ['cell-center.fill'],
  material: ['volume.material'], densityKgM3: ['volume.density'], massKg: ['volume.density'],
};
export function scoreAblationResponse(question: QuestionId, raw: unknown, condition: 'pack' | 'no-pack', context: SpatialModelContext) {
  const parsed = ablationResponseSchema.safeParse(raw);
  if (!parsed.success) return { valid: false, correct: false, referencesValid: false, groundedCorrect: 0, unknownsPreserved: 0, score: 0, answerCoverage: 0, error: 'Output schema rejected.' };
  const response = parsed.data, expected = ABLATION_RUBRIC[question];
  const answers = new Map(response.answers.map(a => [a.key, a]));
  const exactKeys = answers.size === response.answers.length && answers.size === Object.keys(expected).length && Object.keys(expected).every(k => answers.has(k));
  if (!exactKeys) return { valid: false, correct: false, referencesValid: false, groundedCorrect: 0, unknownsPreserved: 0, score: 0, answerCoverage: 0, error: 'Missing, duplicate or unexpected answer keys.' };
  const correct = Object.entries(expected).every(([key, value]) => {
    const got = answers.get(key)!.value;
    return value === null ? got === null : typeof got === 'number' && Math.abs(got - value) <= ABLATION_RUBRIC.absoluteTolerance;
  });
  const facts = new Map(context.facts.map(f => [f.id, f]));
  const referencesValid = response.answers.every(a => {
    if (condition === 'no-pack') return a.value === null && a.entityId === null && a.factIds.length === 0;
    const entity = question === 'center' ? 'cell-center' : 'volume';
    return a.entityId === entity && a.factIds.length > 0 && a.factIds.every(id => facts.get(id)?.entityId === entity)
      && references[a.key].every(id => a.factIds.includes(id));
  });
  const groundedCorrect = Number(correct && referencesValid);
  const unknownsPreserved = Number(new Set(response.unknowns).size === 3 && (question !== 'physical' || response.answers.every(a => a.value === null)));
  return { valid: true, correct, referencesValid, groundedCorrect, unknownsPreserved, score: groundedCorrect + unknownsPreserved,
    answerCoverage: response.answers.filter(a => a.value !== null).length / response.answers.length, error: null };
}
