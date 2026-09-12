// lanes/privacy/scan.mjs is Claude Code's privacy gate (privacy-d5n9): plain
// ESM JavaScript; the seal path and the CLI verb import it for its pattern set.
declare module '*privacy/scan.mjs' {
  export interface PrivacyFinding {
    file: string; line: number; col?: number; pattern: string;
    severity: 'critical' | 'high' | 'medium' | 'review';
    match: string; where: string; tree?: string; commit?: string;
  }
  export interface PrivacyPatterns { v: number; patterns: { id: string; severity: string; re: string; note?: string }[]; allow: string[]; ignore_paths: string[]; /** sha256 of the patterns file (loadPatterns records it so a seal can cite the gate it ran) */ sha256?: string }
  export function loadPatterns(): PrivacyPatterns;
  export function scanText(text: string, file: string, P: PrivacyPatterns, where: string, opts?: Record<string, unknown>): PrivacyFinding[];
  export function scanTree(dir: string, P: PrivacyPatterns, where?: string): PrivacyFinding[];
}
