/**
 * Round R4 (H120): a decision in plain lines for terminal surfaces (src/decision/view.ts). A recommendation is amber
 * ('recommendation'), never a passed, verified or green role, and is said to be a recommendation; an abstention says a
 * person decides and shows the fallback proposal; a fallback says which path ran and why.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClefOmniProvider } from '../src/decision/provider.js';
import { decide } from '../src/decision/service.js';
import { DEFAULT_DECISION_SETTINGS } from '../src/decision/settings.js';
import type { DecisionInput } from '../src/decision/types.js';
import { decisionLines, LINE_ROLES } from '../src/decision/view.js';
import { fixture } from './fixtures/clef-omni/fake.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'timmy-decide-view-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  kind: 'route', operationId: 'o7777aaaa', project: { root, revision: 'abcdef1234567890' },
  instructions: 'Which runtime should take this task?', state: { task: 'FAKE' },
  options: [
    { id: 'codex', label: 'Codex', description: 'Codex', available: true },
    { id: 'pi', label: 'Pi', description: 'Pi', available: true },
    { id: 'openhands', label: 'OpenHands', description: 'OpenHands', available: true },
    { id: 'jcode', label: 'jcode', description: 'jcode', available: false, unavailableReason: 'not installed' },
  ],
  deterministic: { option: 'pi', rule: 'the existing route' },
  ...over,
});
const ON = { ...DEFAULT_DECISION_SETTINGS, useClef: true };
const fx = new ClefOmniProvider({ transport: 'fixture' });

describe('decisionLines', () => {
  it('only the four roles; never passed, verified or green', () => {
    expect([...LINE_ROLES]).toEqual(['recommendation', 'fallback', 'policy', 'muted']);
  });

  it('a recommendation: amber, called a recommendation, review waiting, the excluded option and the scores', async () => {
    const rec = await decide(input(), { settings: ON, provider: fx, fixture: fixture('response-route-ok.json') });
    const lines = decisionLines(rec);
    for (const l of lines) expect(LINE_ROLES).toContain(l.role);
    const recLines = lines.filter((l) => l.role === 'recommendation');
    expect(recLines).toHaveLength(1);
    expect(recLines[0].text).toMatch(/^Recommendation: Codex \(codex\), 71\.0%, ahead by 54\.0%/);
    expect(recLines[0].text).toMatch(/a model recommendation, not evidence/);
    const all = lines.map((l) => l.text).join('\n');
    expect(all).toMatch(/NEEDS YOU/);
    expect(all).toMatch(/jcode.*not installed/);
    expect(all).toMatch(/codex 71\.0%/);
    expect(all).toMatch(/d[0-9a-f]{8}/);
    expect(all).toMatch(/abcdef123456/);
    expect(all).not.toMatch(/\b(passed|verified|PASS)\b/);
  });

  it('an abstention: a person decides, with the fallback proposal', async () => {
    const rec = await decide(input(), { settings: ON, provider: fx, fixture: fixture('response-route-tie.json') });
    const lines = decisionLines(rec);
    expect(lines.filter((l) => l.role === 'recommendation')).toEqual([]);
    const policy = lines.filter((l) => l.role === 'policy').map((l) => l.text).join('\n');
    expect(policy).toMatch(/Needs a person: a tie between codex and pi/);
    const fb = lines.filter((l) => l.role === 'fallback').map((l) => l.text).join('\n');
    expect(fb).toMatch(/Fallback proposal: Pi \(pi\) by the existing route/);
  });

  it('a fallback: which path ran, and why', async () => {
    const rec = await decide(input(), { settings: DEFAULT_DECISION_SETTINGS, provider: fx });
    const lines = decisionLines(rec);
    expect(lines.filter((l) => l.role === 'recommendation')).toEqual([]);
    const fb = lines.filter((l) => l.role === 'fallback').map((l) => l.text).join('\n');
    expect(fb).toMatch(/Fallback used: Pi \(pi\) by the existing route/);
    expect(fb).toMatch(/Decision-model routing is off/);
  });
});
