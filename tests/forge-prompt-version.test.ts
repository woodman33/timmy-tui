import { describe, it, expect } from 'vitest';
import { newPromptVersion, nextPromptVersion, diffVersions, type Beat } from '../src/forge/prompt-version.js';

const beats: Beat[] = [
  { id: 'b1', t: 0, text: 'product rotates in' },
  { id: 'b2', t: 3, text: 'camera orbits left' },
  { id: 'b3', t: 6, text: 'logo reveal' },
];

describe('prompt versions', () => {
  it('preserves supplied parameters and critique without sharing caller state', () => {
    const input = { mission_id: 'm1', stage: 'i2v', prompt: 'x',
      beats: [{ id: 'b1', t: 0, text: 'original' }],
      params: { seed: 42, camera: { speed: 2 } }, critique: 'retain the reason' };
    const version = newPromptVersion(input);
    input.beats[0].text = 'caller mutation';
    input.params.camera.speed = 9;
    expect(version.params).toEqual({ seed: 42, camera: { speed: 2 } });
    expect(version.critique).toBe('retain the reason');
    expect(version.beats[0].text).toBe('original');
    expect(newPromptVersion({ mission_id: 'm1', stage: 'i2v', prompt: 'x', beats }).params).toEqual({});
  });

  it('keeps parent snapshots independent of child and edit-input mutations', () => {
    const parent = newPromptVersion({ mission_id: 'm1', stage: 'i2v', prompt: 'x', beats,
      params: { camera: { speed: 2 } } });
    const edit = { ...beats[1], text: 'edited' };
    const child = nextPromptVersion(parent, { beats: [edit] });
    child.beats[0].text = 'child mutation';
    (child.params.camera as { speed: number }).speed = 99;
    edit.text = 'later caller mutation';
    expect(parent.beats[0].text).toBe(beats[0].text);
    expect(parent.params).toEqual({ camera: { speed: 2 } });
    expect(child.beats[1].text).toBe('edited');
  });

  it('reports timing-only edits and removed beats as changed', () => {
    const parent = newPromptVersion({ mission_id: 'm1', stage: 'i2v', prompt: 'x', beats });
    const child = nextPromptVersion(parent, { beats: [{ ...beats[1], t: 4 }] });
    expect(diffVersions(parent, child).changed_beat_ids).toEqual(['b2']);
    expect(diffVersions(parent, { ...child, beats: child.beats.slice(0, 2) }).changed_beat_ids)
      .toEqual(['b2', 'b3']);
  });

  it('invalidates changed text even when an edit carries validation', () => {
    const parent = newPromptVersion({ mission_id: 'm1', stage: 'i2v', prompt: 'x',
      beats: beats.map(b => ({ ...b, probe_validated: true })) });
    const child = nextPromptVersion(parent, { beats: [{ ...parent.beats[1], text: 'replacement' }] });
    expect(child.beats[1].probe_validated).toBe(false);
    expect(child.beats[0].probe_validated).toBe(true);
    expect(parent.beats[1].probe_validated).toBe(true);
  });

  it.each([4, 9])('invalidates adjacent segment windows and reorderings when a beat moves to %s', t => {
    const parent = newPromptVersion({ mission_id: 'm1', stage: 'i2v', prompt: 'x',
      beats: beats.map(b => ({ ...b, probe_validated: true })) });
    const child = nextPromptVersion(parent, { beats: [{ ...parent.beats[1], t }] });
    expect(child.beats.every(b => b.probe_validated === false)).toBe(true);
    expect(parent.beats.every(b => b.probe_validated === true)).toBe(true);
  });

  it.each([{ prompt: 'new prompt' }, { params: { seed: 2 } }])('invalidates probes when generation inputs change: %j', edit => {
    const parent = newPromptVersion({ mission_id: 'm1', stage: 'i2v', prompt: 'x',
      params: { seed: 1 }, beats: beats.map(b => ({ ...b, probe_validated: true })) });
    expect(nextPromptVersion(parent, edit).beats.every(b => b.probe_validated === false)).toBe(true);
    expect(nextPromptVersion(parent, { params: { seed: 1 }, critique: 'annotation only' })
      .beats.every(b => b.probe_validated === true)).toBe(true);
  });

  it('versions chain with parents and time maps', () => {
    const v1 = newPromptVersion({ mission_id: 'm1', stage: 'i2v', prompt: 'full text', beats });
    const v2 = nextPromptVersion(v1, { beats: [{ ...beats[1], text: 'camera orbits right' }] });
    expect(v2.version).toBe(2);
    expect(v2.parent).toBe(v1.id);
    expect(v2.beats.find(b => b.id === 'b2')!.text).toBe('camera orbits right');
    expect(v2.beats.find(b => b.id === 'b1')!.text).toBe('product rotates in');
  });

  it('diffs isolate changed beats', () => {
    const v1 = newPromptVersion({ mission_id: 'm1', stage: 'i2v', prompt: 'x', beats });
    const v2 = nextPromptVersion(v1, { beats: [{ ...beats[1], text: 'changed' }] });
    const d = diffVersions(v1, v2);
    expect(d.changed_beat_ids).toEqual(['b2']);
    expect(d.unchanged_beat_ids).toEqual(['b1', 'b3']);
  });

  it('throws on unknown beat id in edit.beats', () => {
    const v1 = newPromptVersion({ mission_id: 'm1', stage: 'i2v', prompt: 'x', beats });
    expect(() => nextPromptVersion(v1, { beats: [{ id: 'nope', t: 0, text: 'ghost beat' }] }))
      .toThrowError(/nope/);
  });

  it('throws on duplicate beat ids in edit.beats', () => {
    const v1 = newPromptVersion({ mission_id: 'm1', stage: 'i2v', prompt: 'x', beats });
    expect(() => nextPromptVersion(v1, { beats: [{ ...beats[0], text: 'first' }, { ...beats[0], text: 'second' }] }))
      .toThrowError(/b1/);
  });
});
