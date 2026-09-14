// Type surface of lanes/privacy/scan.mjs for its TypeScript callers (src/cli.ts:
// the `timmy seal` privacy refusal). The .mjs is the implementation; keep the two
// in step when an export changes (ORDER privacy-d5n9).

export type Severity = 'critical' | 'high' | 'medium' | 'review';

export interface Pattern {
  id: string;
  severity: Severity;
  re: string;
  flags?: string;
  note?: string;
  rx: RegExp;
}

export interface PatternSet {
  patterns: Pattern[];
  allow: RegExp[];
  ignore: RegExp[];
  /** sha256(lowercased identity term) → id/severity (blank-slate-v1k9) */
  hashed: Map<string, { id: string; severity: Severity }>;
  sha256: string;
  file: string;
}

export interface Finding {
  file: string;
  line: number;
  col: number;
  pattern: string;
  severity: Severity;
  /** masked: first 3 + last 2 chars, never the full match */
  match: string;
  where: string;
  commit?: string;
  tree?: string;
  [extra: string]: unknown;
}

export interface Summary {
  total: number;
  by_severity: Record<string, number>;
  by_pattern: Record<string, number>;
  files: number;
}

/** The sealed base-identical rule text (privacy.rule). */
export const BASE_RULE: string;
/** The base ref for the base-identical rule (default origin/main; a `A..B` ref uses A), or null. */
export function resolveBase(dir: string, refs?: string[]): string | null;
export const TOKEN_RX: RegExp;
export function hashTerm(term: string): string;
export function loadPatterns(file?: string): PatternSet;
export function scanText(text: string, file: string, P: PatternSet, where: string, extra?: Record<string, unknown>): Finding[];
export function treeFiles(dir: string): string[];
export function scanTree(dir: string, P: PatternSet, where?: string): { findings: Finding[]; files: number; scanned: number };
export function scanStaged(dir: string, P: PatternSet, base?: string | null): { findings: Finding[]; files: number; base: string | null; base_identical: number };
export function scanHistory(dir: string, P: PatternSet, refs?: string[], base?: string | null): { findings: Finding[]; commits: number; blobs: number; base: string | null; base_identical: number };
export function classify(findings: Finding[], treeSet: Set<string>): Array<Finding & { in_tree: boolean }>;
export function summarize(findings: Finding[]): Summary;
export function markdown(title: string, sections: Array<{ title: string; note?: string; findings?: Finding[]; limit?: number }>): string;
