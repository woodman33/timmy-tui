/**
 * Round R4 (H120): `timmy decide` (src/decision/cli.ts: decideMain, decideDo) and its MCP tool (src/decision/mcp.ts:
 * DECISION_TOOLS, callDecisionTool), offline with the fixture transport. Exit codes: 0 recorded (any outcome), 1 refused,
 * 2 usage. The MCP tool returns the CLI's JSON.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECIDE_USAGE, decideDo, decideMain, parseDecideArgs } from '../src/decision/cli.js';
import { callDecisionTool, DECISION_TOOLS } from '../src/decision/mcp.js';
import { fixture, gitProject } from './fixtures/clef-omni/fake.js';

let project: ReturnType<typeof gitProject>;
let out: string[];
let err: string[];
beforeEach(() => {
  project = gitProject('timmy-decide-cli-');
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out.push(String(c)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { err.push(String(c)); return true; });
  vi.stubEnv('TIMMY_CLEF', '1');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(project.root, { recursive: true, force: true });
});

const ROUTE = (...more: string[]): string[] => ['route', '--option', 'codex:Codex', '--option', 'pi', '--option', 'openhands', '--deterministic', 'codex', '--project', project.root, ...more];
const jsonLine = (): Record<string, unknown> => {
  const lines = out.join('').trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as Record<string, unknown>;
};
const records = (root = project.root): string[] => {
  try { return readdirSync(join(root, '.timmy', 'decisions')).filter((n) => /^d[0-9a-f]{8}\.json$/.test(n)); } catch { return []; }
};

describe('timmy decide route --json', () => {
  it('records the decision and prints one line of timmy.decision/1', async () => {
    const code = await decideMain(ROUTE('--fixture', fixture('response-route-ok.json'), '--json'));
    expect(code).toBe(0);
    const j = jsonLine();
    expect(j).toMatchObject({ schema: 'timmy.decision/1', ok: true, exit_code: 0, reused: false, kind: 'route', outcome: 'recommend' });
    expect(j.recommendation).toMatchObject({ option: 'codex', label: 'Codex' });
    expect(j.project).toMatchObject({ revision: project.head });
    expect(String(j.operationId)).toMatch(/^o[0-9a-f]{8}$/);
    expect(j.file).toBe(join('.timmy', 'decisions', `${String(j.id)}.json`));
    expect(j.evidence_kind).toBe('machine_inference');
    expect(j.note).toBe('a model recommendation, not evidence');
    expect(records()).toEqual([`${String(j.id)}.json`]);
  });

  it('the same operation asked again is the recorded decision', async () => {
    await decideMain(ROUTE('--operation', 'o0000cafe', '--fixture', fixture('response-route-ok.json'), '--json'));
    const first = jsonLine();
    out = [];
    await decideMain(ROUTE('--operation', 'o0000cafe', '--fixture', fixture('response-route-tie.json'), '--json'));
    const second = jsonLine();
    expect(second.id).toBe(first.id);
    expect(second.reused).toBe(true);
    expect(second.outcome).toBe('recommend');
    expect(records()).toHaveLength(1);
  });

  it('plain words: the recommendation, said to be one, and where it was kept', async () => {
    const code = await decideMain(ROUTE('--fixture', fixture('response-route-ok.json')));
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toMatch(/codex/);
    expect(text).toMatch(/recommendation/i);
    expect(text).toMatch(/not evidence/);
    expect(text).toMatch(/NEEDS YOU/);
    expect(text).toMatch(/\.timmy\/decisions\/d[0-9a-f]{8}\.json/);
  });

  it('--unavailable lists an option as excluded, with its reason', async () => {
    const code = await decideMain([...ROUTE('--unavailable', 'openhands:Docker is not running', '--fixture', fixture('response-route-ok.json'), '--json')]);
    expect(code).toBe(0);
    const j = jsonLine();
    // the fixture scores openhands, which was not offered: malformed, so the deterministic route is used
    expect(j.outcome).toBe('fallback');
    expect((j.options as { excluded: unknown[] }).excluded).toEqual([{ id: 'openhands', label: 'openhands', reason: 'Docker is not running' }]);
  });

  it('"Use Clef routing" off: recorded as a fallback, exit 0', async () => {
    vi.stubEnv('TIMMY_CLEF', '0');
    const code = await decideMain(ROUTE('--fixture', fixture('response-route-ok.json'), '--json'));
    expect(code).toBe(0);
    expect(jsonLine()).toMatchObject({ outcome: 'fallback', fallback: { used: true, reasonKind: 'clef-off', option: 'codex' } });
  });

  it('a project with no git revision: unresolved, recorded as a fallback', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'timmy-decide-nogit-'));
    try {
      const code = await decideMain(['route', '--option', 'codex', '--option', 'pi', '--deterministic', 'pi', '--project', plain, '--fixture', fixture('response-route-ok.json'), '--json']);
      expect(code).toBe(0);
      const j = jsonLine();
      expect(j).toMatchObject({ outcome: 'fallback', fallback: { reasonKind: 'unresolved-inputs', option: 'pi' } });
      expect(String((j.fallback as { reason: string }).reason)).toMatch(/revision/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('--revision older than the project: stale, recorded as a fallback with no call', async () => {
    const old = project.head;
    project.commit('FAKE: moved on');
    const code = await decideMain(ROUTE('--revision', old, '--fixture', fixture('response-route-ok.json'), '--json'));
    expect(code).toBe(0);
    expect(jsonLine()).toMatchObject({ outcome: 'fallback', fallback: { reasonKind: 'stale-revision' }, project: { revision: old } });
  });

  it('refused (exit 1) when the decisions folder cannot be written', async () => {
    mkdirSync(join(project.root, '.timmy'), { recursive: true });
    writeFileSync(join(project.root, '.timmy', 'decisions'), 'a file where the folder goes');
    const code = await decideMain(ROUTE('--fixture', fixture('response-route-ok.json'), '--json'));
    expect(code).toBe(1);
    expect(jsonLine()).toMatchObject({ schema: 'timmy.decision/1', ok: false, exit_code: 1, refusal: 'not recorded' });
  });
});

describe('usage (exit 2)', () => {
  it.each([
    [[], /kind/],
    [['pick', '--option', 'a', '--option', 'b'], /route, queue, mode or vox-review/],
    [['route'], /--option/],
    [['route', '--option'], /--option needs/],
    [['route', '--option', 'codex', '--option', 'codex'], /more than once/],
    [['route', '--option', 'needs_review', '--option', 'pi'], /reserved/],
    [['route', '--option', 'codex', '--option', 'pi', '--deterministic', 'hermes'], /hermes/],
    [['route', '--option', 'codex', '--option', 'pi', '--operation', 'op-1'], /o and 8 hex digits/],
    [['route', '--option', 'codex', '--option', 'pi', '--budget-usd', '-1'], /--budget-usd/],
    [['route', '--option', 'codex', '--option', 'pi', '--state', '{not json'], /--state/],
    [['route', '--option', 'codex', '--option', 'pi', '--frobnicate'], /--frobnicate/],
    [['route', '--option', 'bad id!', '--option', 'pi'], /option id/],
    [['route', '--option', 'codex', '--option', 'pi', '--project', '/nonexistent/timmy-decide-x'], /--project/],
  ])('%j', async (argv, why) => {
    const code = await decideMain([...argv, '--json']);
    expect(code).toBe(2);
    const j = jsonLine();
    expect(j).toMatchObject({ schema: 'timmy.decision/1', ok: false, exit_code: 2, refusal: 'usage' });
    expect(String(j.why)).toMatch(why);
    expect(err.join('')).toMatch(why);
  });

  it('--help prints the usage and exits 0', async () => {
    expect(await decideMain(['--help'])).toBe(0);
    expect(out.join('')).toContain(DECIDE_USAGE);
    expect(DECIDE_USAGE).toMatch(/timmy decide route --option codex\[:label\]/);
  });

  it('parseDecideArgs reads every flag', () => {
    const a = parseDecideArgs(['route', '--option', 'codex:Codex CLI', '--option=pi', '--unavailable', 'openhands:not installed', '--deterministic', 'codex', '--rule', 'the old route',
      '--instructions', 'Pick one', '--operation', 'o0000beef', '--project', '.', '--revision', 'abc', '--state', '{"a":1}', '--fixture', 'f.json', '--request-key', 'k1',
      '--local-only', '--free-only', '--budget-usd', '0.5', '--json']);
    expect('error' in a).toBe(false);
    if ('error' in a) return;
    expect(a).toMatchObject({
      kind: 'route', deterministic: 'codex', rule: 'the old route', instructions: 'Pick one', operation: 'o0000beef', project: '.', revision: 'abc',
      state: { a: 1 }, fixture: 'f.json', requestKey: 'k1', localOnly: true, freeOnly: true, budgetUsd: 0.5, json: true,
    });
    expect(a.options).toEqual([
      { id: 'codex', label: 'Codex CLI', description: 'Codex CLI', available: true },
      { id: 'pi', label: 'pi', description: 'pi', available: true },
      { id: 'openhands', label: 'openhands', description: 'openhands', available: false, unavailableReason: 'not installed' },
    ]);
  });
});

describe('the MCP tool', () => {
  it('DECISION_TOOLS holds one plain JSON Schema tool, timmy_decide_route', () => {
    expect(DECISION_TOOLS.map((t) => t.name)).toEqual(['timmy_decide_route']);
    const t = DECISION_TOOLS[0];
    expect(t.inputSchema).toMatchObject({ type: 'object', required: ['options'] });
    expect(t.description).toMatch(/recommendation/i);
    expect(t.description).toMatch(/never/i);
  });

  it('returns the CLI\'s JSON for the same request (the same recorded decision)', async () => {
    const cli = await decideDo(ROUTE('--operation', 'o0000d00d', '--fixture', fixture('response-route-ok.json')), {});
    expect(cli.code).toBe(0);
    const mcp = await callDecisionTool('timmy_decide_route', {
      options: [{ id: 'codex', label: 'Codex' }, { id: 'pi' }, { id: 'openhands' }], deterministic: 'codex',
      operation: 'o0000d00d', project: project.root, fixture: fixture('response-route-ok.json'),
    });
    expect(mcp).toMatchObject({ schema: 'timmy.decision/1', ok: true, exit_code: 0, reused: true, id: cli.json.id, outcome: 'recommend', requestKey: cli.json.requestKey });
    const { reused: _a, words: cliWords, ...cliRest } = cli.json;
    const { reused: _b, words: mcpWords, ...mcpRest } = mcp as Record<string, unknown>;
    expect(mcpRest).toEqual(cliRest);
    // R9 (H162): the same words (the lines the CLI prints), but for the last: the second asking returned the recorded one
    expect((mcpWords as string[]).slice(0, -1)).toEqual((cliWords as string[]).slice(0, -1));
    expect((mcpWords as string[]).at(-1)).toMatch(/^The recorded decision, returned again \(asked before; no second call\)/);
  });

  it('applies the same checks: usage problems are exit 2, Clef off is a recorded fallback', async () => {
    expect(await callDecisionTool('timmy_decide_route', { options: [{ id: 'codex' }, { id: 'codex' }], project: project.root })).toMatchObject({ ok: false, exit_code: 2, refusal: 'usage' });
    expect(await callDecisionTool('timmy_decide_route', { project: project.root })).toMatchObject({ ok: false, exit_code: 2 });
    vi.stubEnv('TIMMY_CLEF', '0');
    const off = await callDecisionTool('timmy_decide_route', { options: [{ id: 'codex' }, { id: 'pi' }], deterministic: 'pi', project: project.root });
    expect(off).toMatchObject({ ok: true, exit_code: 0, outcome: 'fallback', fallback: { reasonKind: 'clef-off', option: 'pi' } });
  });

  it('an unknown tool is refused in words', async () => {
    expect(await callDecisionTool('decide_everything', {})).toMatchObject({ ok: false, refusal: 'unknown tool' });
  });
});
