import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export interface Beat { id: string; t: number; text: string; probe_validated?: boolean }

export interface PromptVersion {
  id: string;
  mission_id: string;
  stage: string;              // 't2i' | 'i2v' | 'speak'
  version: number;
  parent: string | null;
  prompt: string;
  beats: Beat[];
  params: Record<string, unknown>;
  critique: string | null;    // the judge critique that motivated this version
  created_ts: string;
}

export function newPromptVersion(init: Omit<PromptVersion, 'id' | 'version' | 'parent' | 'params' | 'critique' | 'created_ts'> & { params?: Record<string, unknown>; critique?: string }): PromptVersion {
  return { ...structuredClone(init), id: randomUUID(), version: 1, parent: null,
    params: structuredClone(init.params ?? {}), critique: init.critique ?? null,
    created_ts: new Date().toISOString() };
}

/** Merge beat edits by id; unedited beats carry over. */
export function nextPromptVersion(prev: PromptVersion, edit: { prompt?: string; beats?: Beat[]; params?: Record<string, unknown>; critique?: string }): PromptVersion {
  const edits = edit.beats ?? [];
  const prevIds = new Set(prev.beats.map(b => b.id));
  const unknownIds = [...new Set(edits.map(b => b.id).filter(id => !prevIds.has(id)))];
  if (unknownIds.length > 0) {
    throw new Error(`nextPromptVersion: edit.beats reference unknown beat id(s): ${unknownIds.join(', ')}`);
  }
  const seenIds = new Set<string>();
  const duplicatedIds = new Set<string>();
  for (const b of edits) {
    if (seenIds.has(b.id)) duplicatedIds.add(b.id);
    seenIds.add(b.id);
  }
  if (duplicatedIds.size > 0) {
    throw new Error(`nextPromptVersion: duplicate beat id(s) in edit.beats: ${[...duplicatedIds].join(', ')}`);
  }
  const beatsById = new Map(edits.map(b => [b.id, b]));
  const prompt = edit.prompt ?? prev.prompt;
  const params = edit.params ?? prev.params;
  const generationChanged = prompt !== prev.prompt || !isDeepStrictEqual(params, prev.params);
  // Segment ends depend on the next beat's start. A timing edit can change
  // neighboring windows or reorder them, so invalidate the entire time map.
  const timingChanged = prev.beats.some(b => (beatsById.get(b.id) ?? b).t !== b.t);
  return {
    ...prev,
    id: randomUUID(),
    version: prev.version + 1,
    parent: prev.id,
    prompt,
    params: structuredClone(params),
    beats: prev.beats.map(b => {
      const next = structuredClone(beatsById.get(b.id) ?? b);
      // A legacy validation flag cannot survive changes to what was probed.
      // This flag is not a substitute for revision-bound evidence admission.
      if (generationChanged || timingChanged || next.text !== b.text) next.probe_validated = false;
      return next;
    }),
    critique: edit.critique ?? null,
    created_ts: new Date().toISOString(),
  };
}

export function diffVersions(a: PromptVersion, b: PromptVersion): { changed_beat_ids: string[]; unchanged_beat_ids: string[]; prompt_changed: boolean } {
  const previous = new Map(a.beats.map(beat => [beat.id, beat]));
  const currentIds = new Set(b.beats.map(beat => beat.id));
  const changed = b.beats.filter(nb => {
    const old = previous.get(nb.id);
    return !old || old.text !== nb.text || old.t !== nb.t;
  }).map(beat => beat.id);
  changed.push(...a.beats.filter(beat => !currentIds.has(beat.id)).map(beat => beat.id));
  return {
    changed_beat_ids: changed,
    unchanged_beat_ids: b.beats.map(b => b.id).filter(id => !changed.includes(id)),
    prompt_changed: a.prompt !== b.prompt,
  };
}
