import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStrictJson } from '../src/utils/strict-json.js';

describe('strict JSON boundary', () => {
  it.each([
    '{"operation":"fit","operation":"probe"}',
    '{"outer":{"x":1,"x":2}}',
    '[{"x":1,"\\u0078":2}]',
    '{"a\\\\b":1,"a\\u005cb":2}',
    '{"__proto__":1,"__proto__":2}',
  ])('rejects duplicate decoded keys in their own object scope', source => {
    expect(() => parseStrictJson(source)).toThrow(expect.objectContaining({ code: 'duplicate_json_key' }));
  });
  it('keeps repeated keys in distinct objects and key-like string contents valid', () => {
    const source = '{"parts":[{"id":"a"},{"id":"b"}],"label":"{\\\"id\\\":1,\\\"id\\\":2}","nested":{"parts":[]}}';
    expect(parseStrictJson(source)).toEqual(JSON.parse(source));
  });
  it('preserves valid primitive and numeric values', () => {
    for (const source of ['null', 'true', 'false', '"a"', '-0', '1.25e-20', '[1e308,{},[]]']) {
      expect(parseStrictJson(source)).toEqual(JSON.parse(source));
    }
  });
  it.each(['1e309', '{"amount":-1e999}', '[0,1e309]'])('refuses overflow to nonfinite numbers', source => {
    expect(() => parseStrictJson(source)).toThrow(expect.objectContaining({ code: 'nonfinite_json_number' }));
  });
  it.each(['{"a":1,}', '{"a":NaN}', '/* comment */ {}', '{} {}', ''])('keeps the native JSON grammar strict', source => {
    expect(() => parseStrictJson(source)).toThrow(expect.objectContaining({ code: 'invalid_json' }));
  });
  it('bounds UTF-8 bytes and nesting before returning data', () => {
    expect(() => parseStrictJson('"éé"', { maxBytes: 5 })).toThrow(expect.objectContaining({ code: 'json_exceeds_byte_limit' }));
    expect(parseStrictJson('[[1]]', { maxDepth: 2 })).toEqual([[1]]);
    expect(() => parseStrictJson('[[[1]]]', { maxDepth: 2 })).toThrow(expect.objectContaining({ code: 'json_exceeds_depth_limit' }));
  });
  it('refuses ambiguous CLI input before dispatch and leaves original bytes unchanged', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'timmy-strict-request-')));
    try {
      const file = join(directory, 'request.json'), store = join(directory, 'receipts');
      const bytes = Buffer.from('{"operation":"fit", "operation":"probe"}\n');
      writeFileSync(file, bytes);
      const result = spawnSync(process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'vision', 'integrations', 'run', 'camera-fit', '--request', file], {
          cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
          env: { ...process.env, NODE_ENV: 'test', TIMMY_STORE: store, TIMMY_VISUAL_PYTHON: '/unavailable-camera-python' },
        });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('Duplicate JSON object key');
      expect(existsSync(join(store, 'integrations'))).toBe(false);
      expect(existsSync(join(store, 'runs.jsonl'))).toBe(false);
      expect(readFileSync(file)).toEqual(bytes);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
