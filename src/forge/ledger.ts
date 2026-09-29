// Hash-chained JSONL ledger for forge generation records.
// Append-only, no signatures (receipts carry those). Writers serialize
// via the same lock discipline as receipts (withLockDir from src/utils/receipts.ts).
// Store resolution mirrors receipts.ts: TIMMY_STORE applies only for the cwd
// default; an explicit dir resolves through rootStoreDir -> <dir>/.timmy.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { rootStoreDir, withLockDir } from '../utils/receipts.js';

export interface LedgerRecord {
  seq: number;
  ts: string;
  kind: string;          // 'generation' | 'prompt_version' | 'judge_score' | 'diff' | 'cache_hit' | ...
  prev_hash: string;
  hash: string;
  [k: string]: unknown;
}

function ledgerDir(dir: string): string {
  // same precedence as receiptsDir(): per-test TIMMY_STORE only when the caller
  // didn't pass an explicit dir; explicit dirs resolve via store-pin/legacy root
  if (process.env.TIMMY_STORE && dir === process.cwd()) return join(process.env.TIMMY_STORE, 'forge');
  return join(rootStoreDir(dir) ?? join(dir, '.timmy'), 'forge');
}

function ledgerPath(dir: string): string {
  return join(ledgerDir(dir), 'ledger.jsonl');
}

// Canonical form contract: keys of plain objects are sorted RECURSIVELY at
// every depth; arrays are order-significant and keep their element order.
// Callers exclude `hash` from the hashed body.
function canonValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonValue);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.keys(o)
      .sort()
      .reduce((acc, k) => ({ ...acc, [k]: canonValue(o[k]) }), {});
  }
  return v;
}

function canon(v: Record<string, unknown>): string {
  // Normalize to the representation JSONL can actually retain (including
  // Date/toJSON values) before sorting. Hashing a different representation
  // would produce a record that fails verification immediately after writing.
  return JSON.stringify(canonValue(JSON.parse(JSON.stringify(v))));
}

export function hashOf(v: Record<string, unknown>): string {
  return 'sha256_' + createHash('sha256').update(canon(v)).digest('hex');
}

// The initial unversioned writer sorted only top-level keys. Its hash still
// covers all nested values, in their retained insertion order.
function legacyHashOf(v: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]]));
  return 'sha256_' + createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// Omit<> over the index-signature interface collapses to the bare index
// signature, so the input type is declared explicitly instead.
export type LedgerInput = { kind: string } & Record<string, unknown>;

const RESERVED = ['seq', 'ts', 'prev_hash', 'hash', 'hash_version'];
function checkInput(input: LedgerInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('ledger input must be an object');
  }
  for (const key of RESERVED) {
    if (Object.hasOwn(input, key)) throw new Error(`reserved ledger field: ${key}`);
  }
  if (typeof input.kind !== 'string' || !input.kind.trim()) {
    throw new Error('ledger kind must be a nonempty string');
  }
}

export function appendLedger(input: LedgerInput, dir = process.cwd()): LedgerRecord {
  checkInput(input);
  const normalized: LedgerInput = JSON.parse(JSON.stringify(input));
  checkInput(normalized);
  return withLockDir(join(ledgerDir(dir), '.lock'), () => {
    const p = ledgerPath(dir);
    mkdirSync(dirname(p), { recursive: true });
    const rows = readLedger(dir, { verify: true });
    const prev = rows[rows.length - 1];
    const base = {
      ...normalized,
      hash_version: 2,
      seq: rows.length,
      ts: new Date().toISOString(),
      prev_hash: prev?.hash ?? 'genesis'
    };
    const rec: LedgerRecord = { ...base, hash: hashOf(base) };
    appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  });
}

export function readLedger(dir = process.cwd(), opts: { verify?: boolean } = {}): LedgerRecord[] {
  const p = ledgerPath(dir);
  if (!existsSync(p)) return [];
  const text = readFileSync(p, 'utf8');
  if (!text) return [];
  if (!text.endsWith('\n')) throw new Error('chain broken (incomplete final record)');
  const rows = text.slice(0, -1).split('\n').map((line, index) => {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        throw new Error(`chain broken at line ${index + 1} (invalid JSON)`);
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`chain broken at line ${index + 1} (invalid record)`);
      }
      const r = row as LedgerRecord;
      if (!Number.isSafeInteger(r.seq) || r.seq < 0 ||
          typeof r.kind !== 'string' || !r.kind.trim() ||
          typeof r.ts !== 'string' || !Number.isFinite(Date.parse(r.ts)) ||
          typeof r.prev_hash !== 'string' || typeof r.hash !== 'string' ||
          !/^sha256_[a-f0-9]{64}$/.test(r.hash) ||
          (Object.hasOwn(r, 'hash_version') && r.hash_version !== 2)) {
        throw new Error(`chain broken at line ${index + 1} (invalid record fields)`);
      }
      return r;
    });
  if (opts.verify !== false) {
    // This checks internal consistency, not authenticity or full-chain
    // replacement. An independently retained head is needed for that claim.
    // Both historical unversioned encodings cover the entire record. Accept
    // their original digests without rewriting bytes; version 2 uses only the
    // recursive format. Unknown versions already refuse above.
    if (rows[0] && rows[0].prev_hash !== 'genesis') {
      throw new Error(`chain broken at seq ${rows[0].seq} (genesis anchor mismatch)`);
    }
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].seq !== i) throw new Error(`chain broken at seq ${rows[i].seq} (seq gap)`);
      const { hash, ...rest } = rows[i];
      const matches = hashOf(rest) === hash ||
        (!Object.hasOwn(rest, 'hash_version') && legacyHashOf(rest) === hash);
      if (!matches) throw new Error(`chain broken at seq ${rows[i].seq} (hash mismatch)`);
      if (i > 0 && rest.prev_hash !== rows[i - 1].hash) throw new Error(`chain broken at seq ${rows[i].seq} (link mismatch)`);
    }
  }
  return rows;
}

export function ledgerHead(dir = process.cwd()): LedgerRecord | undefined {
  const rows = readLedger(dir);
  return rows[rows.length - 1];
}
