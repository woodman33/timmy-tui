import { describe, it, expect } from 'vitest';
import { ABLATION_RUBRIC, scoreAblationResponse } from '../src/vision/spatial/ablation.js';
import { buildVolumeModelContext } from '../src/vision/spatial/model-context.js';

const context = buildVolumeModelContext('studio/spatial-volume-20260912/grid10/manifest.json');
const unknowns = ['material', 'density', 'mass'];
const counts = { answers: Object.entries(ABLATION_RUBRIC.counts).map(([key, value]) => ({ key, value, entityId: 'volume', factIds: [key === 'knownLocations' ? 'volume.location-count' : key === 'totalCells' ? 'volume.total-cells' : 'volume.fill-coverage'] })), unknowns };
describe('frozen spatial ablation scoring', () => {
  it('requires both correct numeric values and relevant source/entity citations', () => {
    expect(scoreAblationResponse('counts', counts, 'pack', context)).toMatchObject({ correct: true, referencesValid: true, score: 2 });
    const wrong = structuredClone(counts); wrong.answers[0].factIds = ['cell-center.location'];
    expect(scoreAblationResponse('counts', wrong, 'pack', context)).toMatchObject({ correct: true, referencesValid: false, score: 1 });
    wrong.answers[0].factIds = ['volume.material'];
    expect(scoreAblationResponse('counts', wrong, 'pack', context).groundedCorrect).toBe(0);
  });
  it('does not give grounded credit to numerical guesses without a pack', () => {
    const guesses = { ...counts, answers: counts.answers.map(a => ({ ...a, entityId: null, factIds: [] })) };
    expect(scoreAblationResponse('counts', guesses, 'no-pack', context)).toMatchObject({ correct: true, groundedCorrect: 0, unknownsPreserved: 1 });
  });
  it('preserves legitimate no-pack abstention instead of calling it a hallucination', () => {
    const absent = { answers: Object.keys(ABLATION_RUBRIC.physical).map(key => ({ key, value: null, entityId: null, factIds: [] })), unknowns };
    expect(scoreAblationResponse('physical', absent, 'no-pack', context)).toMatchObject({ correct: true, groundedCorrect: 1, unknownsPreserved: 1, answerCoverage: 0 });
    const unavailableCounts = { ...counts, answers: counts.answers.map(a => ({ ...a, value: null, entityId: null, factIds: [] })) };
    expect(scoreAblationResponse('counts', unavailableCounts, 'no-pack', context)).toMatchObject({ correct: false, referencesValid: true, score: 1, answerCoverage: 0 });
  });
  it('rejects fabricated material, duplicated keys and missing output', () => {
    const physical = { answers: Object.keys(ABLATION_RUBRIC.physical).map(key => ({ key, value: key === 'material' ? 'steel' : null, entityId: 'volume', factIds: [key === 'material' ? 'volume.material' : 'volume.density'] })), unknowns };
    expect(scoreAblationResponse('physical', physical, 'pack', context)).toMatchObject({ correct: false, unknownsPreserved: 0, score: 0 });
    expect(scoreAblationResponse('counts', { ...counts, answers: [counts.answers[0], counts.answers[0]] }, 'pack', context)).toMatchObject({ valid: false, score: 0 });
    expect(scoreAblationResponse('counts', null, 'pack', context).score).toBe(0);
  });
});
