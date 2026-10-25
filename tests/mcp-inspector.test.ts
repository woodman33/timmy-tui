/**
 * R6 (H142): the Tools & MCP inspector's strict tool-schema rule (src/mcp/inspector.ts strictIssues) is the schema lane's own
 * (lanes/schema/lane.mjs strictIssues), issue for issue. The lane runs its lane when it is imported (it spawns Timmy's MCP
 * server and exits), so its function is read from the lane's file as it is and run alone, in a context of its own; nothing
 * is started. The schemas: the FAKE fixture's five (src/mcp/fake-fixture-server.ts, every tool made up) and FAKE schemas made
 * here to break each part of the rule.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FAKE_TOOLS } from '../src/mcp/fake-fixture-server.js';
import { schemaGate, strictIssues } from '../src/mcp/inspector.js';

const LANE = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'lanes', 'schema', 'lane.mjs');

/** The lane's strictIssues, as its file has it, run alone (nothing else of the lane runs). */
function laneStrictIssues(): (name: string, s: unknown) => string[] {
  const src = readFileSync(LANE, 'utf8');
  const m = /^export function strictIssues\(name, s, path = ''\) \{\n[\s\S]*?\n\}\n/m.exec(src);
  if (!m) throw new Error('lanes/schema/lane.mjs has no strictIssues(name, s, path) as this test reads it');
  const fn = vm.runInNewContext(`(${m[0].replace(/^export /, '')})`) as (name: string, s: unknown) => string[];
  return (name, s) => JSON.parse(JSON.stringify(fn(name, s))) as string[];
}

const FAKE_BAD: Array<[string, unknown]> = [
  ['FAKE array without items', { type: 'object', properties: { tags: { type: 'array' } } }],
  ['FAKE nested', { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'array', items: { type: 'array' } } } } } }],
  ['FAKE keywords', { type: 'object', properties: { x: { oneOf: [{ type: 'string' }] }, y: { allOf: [] }, z: { not: {} }, w: { type: 'object', patternProperties: {} }, v: { $ref: '#/x' } }, $defs: {} }],
  ['FAKE anyOf', { type: 'object', properties: { u: { anyOf: [{ type: 'array' }, { type: 'object', properties: { type: { type: 'string' } } }] } } }],
  ['FAKE reserved names', { type: 'object', properties: { type: { type: 'string' }, items: {}, properties: {}, required: {}, enum: {} } }],
  ['FAKE root array', { type: 'array' }],
  ['FAKE not a schema', null],
];

describe('the inspector\'s strict tool-schema rule is the schema lane\'s (R6 H142)', () => {
  const lane = laneStrictIssues();

  it('the FAKE fixture\'s five schemas: no issue, by both', () => {
    expect(FAKE_TOOLS.length).toBe(5);
    for (const t of FAKE_TOOLS) {
      expect(strictIssues(t.inputSchema), t.name).toEqual([]);
      expect(lane(t.name, t.inputSchema), t.name).toEqual([]);
    }
    expect(schemaGate(FAKE_TOOLS.map((t) => ({ name: t.name, inputSchema: t.inputSchema, required: [], params: [] })))).toEqual({ checked: 5, missing: 0, issues: [], collisions: [] });
  });

  it('each FAKE schema that breaks the rule: the same issues, in the same order, worded the same', () => {
    let total = 0;
    for (const [name, schema] of FAKE_BAD) {
      const mine = strictIssues(schema);
      expect(mine, name).toEqual(lane(name, schema));
      total += mine.length;
    }
    // the rule did find something in each one that should break it (not two empty lists agreeing)
    expect(FAKE_BAD.filter(([, s]) => s !== null).every(([, s]) => strictIssues(s).length > 0)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(15);
    expect(strictIssues(FAKE_BAD[0][1])).toEqual(['.tags: array without items']);
    expect(strictIssues(FAKE_BAD[5][1])).toEqual(['(root): array without items']);
  });

  it('the gate counts what the rule says, and a name listed twice', () => {
    const tools = [
      { name: 'fake_a', inputSchema: FAKE_BAD[0][1] as Record<string, unknown>, required: [], params: ['tags'] },
      { name: 'fake_a', inputSchema: { type: 'object' }, required: [], params: [] },
      { name: 'fake_b', required: [], params: [] },
    ];
    expect(schemaGate(tools)).toEqual({ checked: 2, missing: 1, issues: [{ tool: 'fake_a', issue: '.tags: array without items' }], collisions: ['fake_a'] });
  });
});
