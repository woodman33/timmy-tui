// tui-redesign-p6a3 STEP 7 — LIBRARY per spec §06: MODELS picker (role
// groups, / fuzzy, pinned float, real spend), FLEET routes from
// harness.policy (● connected / ○ not configured dim), BOARDS + PROJECTS.
// Picker writes hit owner files (model-policy.json, models/notes.json) —
// snapshot + restore around the suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { policyPath, readPolicy } from '../src/harness/policy.js';
import { notesPath } from '../src/models/registry.js';

process.env.TIMMY_TELEMETRY_URL = 'off';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 20000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const f = view.lastFrame() ?? '';
    if (pred(f)) return f;
    if (Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}

let policyBackup: string | null = null;
let notesBackup: string | null = null;
beforeAll(() => {
  policyBackup = existsSync(policyPath()) ? readFileSync(policyPath(), 'utf8') : null;
  notesBackup = existsSync(notesPath()) ? readFileSync(notesPath(), 'utf8') : null;
});
afterAll(() => {
  if (policyBackup !== null) writeFileSync(policyPath(), policyBackup);
  else if (existsSync(policyPath())) writeFileSync(policyPath(), '{}');
  if (notesBackup !== null) writeFileSync(notesPath(), notesBackup);
});

describe('LIBRARY tab (spec §06)', { timeout: 60000 }, () => {
  it('models picker + fleet routes + boards; Enter/h/p/n write policy + notes', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('4');
    let f = await until(view, x => x.includes('◇ MODELS'));
    expect(f).toContain('TIMMY');
    expect(f).toContain('role:');
    expect(f).toContain('◇ FLEET');
    expect(f).toContain('not_configured');   // absent lanes render dim, not red
    expect(f).toContain('◇ BOARDS');
    expect(f).toContain('template');
    expect(f).toContain('PROJECTS');

    // [Enter] sets the policy default for the selected model
    view.stdin.write('\r');
    f = await until(view, x => x.includes('policy model →'));
    const pdir = dirname(process.env.TIMMY_STORE as string);
    const pol = readPolicy(pdir);
    expect(pol.default).toBeTruthy();

    // [h] harness sub-picker writes harness.policy scope
    view.stdin.write('h');
    f = await until(view, x => x.includes('HARNESS — who gets this model?'));
    view.stdin.write('\r');
    f = await until(view, x => x.includes('harness.policy'));
    const pol2 = readPolicy(pdir);
    expect(Object.keys(pol2.scopes).some(k => k.startsWith('harness:'))).toBe(true);

    // [p] pin TOGGLES the selected model (notes.json); the flash names the id
    view.stdin.write('p');
    f = await until(view, x => /(?:un)?pinned/.test(x));
    const pinId = (f.match(/(\S+) (?:un)?pinned/) ?? [])[1];
    expect(pinId).toBeTruthy();
    const notes = JSON.parse(readFileSync(notesPath(), 'utf8')) as Record<string, { pinned?: boolean }>;
    expect(notes[pinId]).toBeDefined();

    // [n] note saves free text against the (possibly re-sorted) selected model
    view.stdin.write('n');
    f = await until(view, x => x.includes('NOTE —'));
    view.stdin.write('judge tier 1');
    view.stdin.write('\r');
    f = await until(view, x => x.includes('note saved for'));
    const noteId = (f.match(/note saved for (\S+)/) ?? [])[1];
    expect(noteId).toBeTruthy();
    const notes2 = JSON.parse(readFileSync(notesPath(), 'utf8')) as Record<string, { notes?: string }>;
    expect(notes2[noteId]?.notes).toBe('judge tier 1');

    // / fuzzy filter narrows the picker (last: leaving INSERT needs no clear)
    view.stdin.write('/');
    view.stdin.write('nemotron');
    f = await until(view, x => x.includes('/ nemotron'));
    expect(f).toContain('nemotron');
    expect(f).not.toContain('grok');
    view.unmount();
  });
});
