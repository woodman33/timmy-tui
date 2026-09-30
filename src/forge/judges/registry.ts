// Specialist judge registry (data only; loading + wiring in later tasks).

export interface SpecialistEntry {
  id: string;
  trigger_hints: string[];
  facets: string[];
  system_prompt_file: string;
}

export const SPECIALISTS: SpecialistEntry[] = [
  // v1 seed entries — refine in Task 8+/evals
  { id: 'subject-presence',  trigger_hints: ['subject', 'missing', 'empty frame'],       facets: ['subject_presence', 'framing'],          system_prompt_file: 'judges/subject-presence.md' },
  { id: 'text-integrity',    trigger_hints: ['text', 'garbled', 'typo', 'glyph'],        facets: ['text_legibility', 'text_accuracy'],      system_prompt_file: 'judges/text-integrity.md' },
  { id: 'identity-lock',     trigger_hints: ['face', 'identity', 'character drift'],     facets: ['identity_match', 'consistency'],         system_prompt_file: 'judges/identity-lock.md' },
  { id: 'motion-coherence',  trigger_hints: ['motion', 'jitter', 'warp', 'morph'],       facets: ['motion_quality', 'temporal_coherence'],  system_prompt_file: 'judges/motion-coherence.md' },
];

export function matchSpecialists(hints: string[]): SpecialistEntry[] {
  const hay = hints.map(h => h.toLowerCase());
  return SPECIALISTS.filter(s => s.trigger_hints.some(t => hay.some(h => h.includes(t))));
}
