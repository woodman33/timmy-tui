import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { setModel, modelFor, harnessFields, readPolicy } from '../src/harness/policy.js';
import { fuzzyMatch, runJbone, loadTemplates } from '../src/jbone/resolver.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(tmpdir() + '/timmy-cp-'); delete process.env.OPENROUTER_API_KEY; });

describe('harness model policy (control-plane-k3e7)', () => {
  it('model set writes default + harness scopes', () => {
    setModel('qwen/qwen3-coder', null, dir);
    setModel('anthropic/claude-sonnet-4.5', 'harness:opencode', dir);
    expect(modelFor('opencode', dir)).toBe('anthropic/claude-sonnet-4.5');
    expect(modelFor('hermes', dir)).toBe('qwen/qwen3-coder');
    expect(readPolicy(dir).scopes['harness:opencode']).toBe('anthropic/claude-sonnet-4.5');
  });
  it('OpenRouter-capable harness reports source=openrouter when key present, else harness-config', () => {
    setModel('qwen/qwen3-coder', null, dir);
    expect(harnessFields('opencode', dir).model_source).toBe('harness-config');
    process.env.OPENROUTER_API_KEY = 'sk-test';
    expect(harnessFields('opencode', dir).model_source).toBe('openrouter');
    delete process.env.OPENROUTER_API_KEY;
    expect(harnessFields('jcode', dir).model_source).toBe('harness-config'); // subscription-only
    expect(harnessFields('jcode', dir).harness_version).toBeTruthy();
  });
});

describe('jbone resolver v0 (control-plane-k3e7)', () => {
  it('seeds three templates and fuzzy-matches phrases', () => {
    expect(loadTemplates().length).toBe(3);
    expect(fuzzyMatch('refactor the drop watcher').template?.file).toBe('refactor.cue');
    expect(fuzzyMatch('add a regression test').template?.file).toBe('test.cue');
    expect(fuzzyMatch('ship the release').template?.file).toBe('ship.cue');
  });
  it('confirm-then-dispatch: pending without --yes, dispatched/stored with it', () => {
    const p = runJbone('refactor the watcher', { dir });
    expect(p.status).toBe('pending-confirm');
    expect(p.confirm).toContain('refactor.cue');
    const y = runJbone('refactor the watcher', { yes: true, dir });
    expect(['dispatched', 'plan-stored']).toContain(y.status);
    expect(y.lane).toBe('opencode');
  });
});
