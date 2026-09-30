import { describe, it, expect, afterEach } from 'vitest';
import { appendLedger, readLedger, ledgerHead, hashOf } from '../src/forge/ledger.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];
function tempLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-ledger-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('forge ledger', () => {
  it('appends records with hash chain', () => {
    const dir = tempLedger();
    const a = appendLedger({ kind: 'generation', endpoint: 'dop-turbo', cost_usd: 0.05 }, dir);
    const b = appendLedger({ kind: 'prompt_version', prompt: 'x' }, dir);
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(b.prev_hash).toBe(a.hash);
    const rows = readLedger(dir);
    expect(rows).toHaveLength(2);
    expect(ledgerHead(dir)!.hash).toBe(b.hash);
  });

  it('hashes nested key order canonically', () => {
    // same semantic record built with different key insertion order at the
    // top level, inside a nested object, and inside array elements
    const a = hashOf({
      kind: 'judge_score',
      seq: 3,
      judge: { model: 'dop-judge', scores: { clarity: 9, punch: 7 } },
      beats: [{ score: 8, name: 'hook' }, { name: 'arc', score: 6 }],
    });
    const b = hashOf({
      beats: [{ score: 8, name: 'hook' }, { name: 'arc', score: 6 }],
      judge: { scores: { punch: 7, clarity: 9 }, model: 'dop-judge' },
      seq: 3,
      kind: 'judge_score',
    });
    expect(a).toBe(b);
  });

  it('verifies a clean chain intact', () => {
    const dir = tempLedger();
    const a = appendLedger(
      { kind: 'generation', endpoint: 'dop-turbo', judge: { clarity: 9 }, beats: [{ score: 8 }] },
      dir
    );
    const b = appendLedger({ kind: 'prompt_version', prompt: 'x' }, dir);
    const rows = readLedger(dir, { verify: true });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(a);
    expect(rows[1]).toEqual(b);
    expect(rows[1].prev_hash).toBe(a.hash);
  });

  it('detects tampering', () => {
    const dir = tempLedger();
    appendLedger({ kind: 'generation', endpoint: 'dop-turbo' }, dir);
    const p = join(dir, '.timmy', 'forge', 'ledger.jsonl');
    // corrupt the file
    writeFileSync(p, readFileSync(p, 'utf8').replace('dop-turbo', 'evil-endpoint'));
    expect(() => readLedger(dir, { verify: true })).toThrow(/chain broken/);
  });

  it.each(['{broken\n', '{}\n', 'null\n', '\n', '[]\n', '{"hash":"x"}\n'])
  ('refuses corrupt records without changing the original bytes: %j', (bad) => {
    const dir = tempLedger();
    appendLedger({ kind: 'generation' }, dir);
    const p = join(dir, '.timmy', 'forge', 'ledger.jsonl');
    const valid = readFileSync(p, 'utf8');
    for (const content of [bad + valid, valid + bad, valid + bad + valid]) {
      writeFileSync(p, content);
      expect(() => readLedger(dir, { verify: true })).toThrow(/chain broken/);
      expect(() => readLedger(dir)).toThrow(/chain broken/);
      expect(() => appendLedger({ kind: 'generation' }, dir)).toThrow(/chain broken/);
      expect(readFileSync(p, 'utf8')).toBe(content);
    }
  });

  it('refuses a partial final record and releases the append lock', () => {
    const dir = tempLedger();
    appendLedger({ kind: 'generation' }, dir);
    const p = join(dir, '.timmy', 'forge', 'ledger.jsonl');
    const partial = readFileSync(p, 'utf8').trimEnd();
    writeFileSync(p, partial);
    expect(() => readLedger(dir)).toThrow(/chain broken/);
    expect(() => appendLedger({ kind: 'generation' }, dir)).toThrow(/chain broken/);
    expect(readFileSync(p, 'utf8')).toBe(partial);
    expect(existsSync(join(dir, '.timmy', 'forge', '.lock'))).toBe(false);
  });

  it('refuses appends to a tampered chain', () => {
    const dir = tempLedger();
    appendLedger({ kind: 'generation', endpoint: 'original' }, dir);
    const p = join(dir, '.timmy', 'forge', 'ledger.jsonl');
    const tampered = readFileSync(p, 'utf8').replace('original', 'modified');
    writeFileSync(p, tampered);
    expect(() => ledgerHead(dir)).toThrow(/chain broken/);
    expect(() => appendLedger({ kind: 'generation' }, dir)).toThrow(/chain broken/);
    expect(readFileSync(p, 'utf8')).toBe(tampered);
  });

  it.each(['hash', 'prev_hash', 'seq', 'ts', 'hash_version'])
  ('rejects caller-owned ledger metadata: %s', (key) => {
    const dir = tempLedger();
    expect(() => appendLedger({ kind: 'generation', [key]: 'injected' }, dir)).toThrow(/reserved/);
    expect(existsSync(join(dir, '.timmy'))).toBe(false);
  });

  it('hashes the same JSON representation it writes', () => {
    const dir = tempLedger();
    const row = appendLedger({ kind: 'generation', at: new Date('2026-01-01T00:00:00Z'),
      custom: { toJSON: () => ({ nested: 1 }) } }, dir);
    expect(row.at).toBe('2026-01-01T00:00:00.000Z');
    expect(row.custom).toEqual({ nested: 1 });
    expect(readLedger(dir, { verify: true })).toEqual([row]);
    expect(row.hash_version).toBe(2);
  });

  it('reads existing recursive-format records without rewriting them', () => {
    const dir = tempLedger();
    appendLedger({ kind: 'generation' }, dir);
    const p = join(dir, '.timmy', 'forge', 'ledger.jsonl');
    const legacy = { kind: 'generation', seq: 0, ts: '2026-01-01T00:00:00Z',
      prev_hash: 'genesis', nested: { z: 2, a: 1 } };
    const original = JSON.stringify({ ...legacy, hash: hashOf(legacy) }) + '\n';
    writeFileSync(p, original);
    appendLedger({ kind: 'generation' }, dir);
    expect(readLedger(dir)).toHaveLength(2);
    expect(readFileSync(p, 'utf8').startsWith(original)).toBe(true);
  });

  it('extends original shallow-format history without rewriting its bytes', () => {
    const dir = tempLedger();
    appendLedger({ kind: 'generation' }, dir);
    const p = join(dir, '.timmy', 'forge', 'ledger.jsonl');
    // Fixed fixture from the first writer's top-level-only canonicalization.
    const original = '{"kind":"generation","seq":0,"ts":"2026-01-01T00:00:00Z","prev_hash":"genesis","nested":{"z":2,"a":1},"hash":"sha256_2318c1932c6e5702d639d4f3828ac66af642280cc7a1e2667e733174d8561abf"}\n';
    writeFileSync(p, original);
    appendLedger({ kind: 'generation', nested: { a: 3 } }, dir);
    expect(readLedger(dir)).toHaveLength(2);
    expect(readFileSync(p, 'utf8').startsWith(original)).toBe(true);
    const tampered = readFileSync(p, 'utf8').replace('"z":2', '"z":9');
    writeFileSync(p, tampered);
    expect(() => appendLedger({ kind: 'generation' }, dir)).toThrow(/hash mismatch/);
    expect(readFileSync(p, 'utf8')).toBe(tampered);
  });

  it('refuses unknown hash versions', () => {
    const dir = tempLedger();
    const row = appendLedger({ kind: 'generation' }, dir);
    const p = join(dir, '.timmy', 'forge', 'ledger.jsonl');
    const { hash, ...body } = row;
    const future = { ...body, hash_version: 3 };
    writeFileSync(p, JSON.stringify({ ...future, hash: hashOf(future) }) + '\n');
    expect(() => readLedger(dir)).toThrow(/invalid record fields/);
  });
});
