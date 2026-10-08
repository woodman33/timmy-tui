// The exempt-blob rule of the privacy gate (lanes/privacy/scan.mjs, EXEMPT_RULE): a file is let
// through for the patterns an entry names only when its path AND its exact bytes match the entry.
// Every other case is scanned in full, which the negative controls below assert first.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Assembled at run time so this file carries no literal the gate blocks.
const addr = ['licensor', 'vendor-mail.test'].join('@');
const home = ['', 'Users', 'someone', 'x'].join('/');
const text = `Copyright (c) 2026 Licensor <${addr}>\nPermission is hereby granted, free of charge.\n`;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const PIN = 'third_party/LICENSE-x.md';

function repo(files: Record<string, string>, commit = false): string {
  const d = mkdtempSync(join(tmpdir(), 'exempt-'));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  g('add', '-A');
  if (commit) g('commit', '-qm', 'add');
  return d;
}

/** The real pattern set with `exempt_blobs` replaced, written to a scratch file. */
function patternsWith(exempt: unknown[]): string {
  const p = JSON.parse(readFileSync('lanes/privacy/patterns.json', 'utf8'));
  p.exempt_blobs = exempt;
  const f = join(mkdtempSync(join(tmpdir(), 'patterns-')), 'patterns.json');
  writeFileSync(f, JSON.stringify(p));
  return f;
}

const entry = (body: string, path = PIN, patterns = ['pii.email']) => ({ path, sha256: sha(body), patterns, why: 'a third-party license text, verbatim' });
const pats = (r: { findings: { file: string; pattern: string }[] }, file: string) => r.findings.filter((f) => f.file === file).map((f) => f.pattern);

describe('privacy gate: exempt blobs (path and exact bytes)', () => {
  it('negative control: one changed byte at the pinned path is scanned in full', async () => {
    const { loadPatterns, scanTree } = await import('../lanes/privacy/scan.mjs');
    const P = loadPatterns(patternsWith([entry(text)]));
    const changed = text.replace('free', 'Free');
    expect(pats(scanTree(repo({ [PIN]: changed }), P), PIN)).toContain('pii.email');
  });

  it('negative control: the pinned bytes at any other path are scanned in full', async () => {
    const { loadPatterns, scanTree } = await import('../lanes/privacy/scan.mjs');
    const P = loadPatterns(patternsWith([entry(text)]));
    expect(pats(scanTree(repo({ 'docs/LICENSE-x.md': text }), P), 'docs/LICENSE-x.md')).toContain('pii.email');
  });

  it('negative control: a pattern the entry does not name still blocks the pinned file', async () => {
    const { loadPatterns, scanTree } = await import('../lanes/privacy/scan.mjs');
    const body = `${text}See ${home}/notes.\n`;
    const P = loadPatterns(patternsWith([entry(body)]));
    const found = pats(scanTree(repo({ [PIN]: body }), P), PIN);
    expect(found).toContain('pii.home_path');
    expect(found).not.toContain('pii.email');
  });

  it('the pinned path with the pinned bytes drops only the named pattern, and says how many it dropped', async () => {
    const { loadPatterns, scanTree } = await import('../lanes/privacy/scan.mjs');
    const P = loadPatterns(patternsWith([entry(text)]));
    const r = scanTree(repo({ [PIN]: text }), P);
    expect(pats(r, PIN)).toEqual([]);
    expect(r.exempted).toBe(1);
  });

  it('the staged and history scans hold to the same pin', async () => {
    const { loadPatterns, scanStaged, scanHistory } = await import('../lanes/privacy/scan.mjs');
    const P = loadPatterns(patternsWith([entry(text)]));
    const staged = repo({ [PIN]: text, 'other.md': text });
    const s = scanStaged(staged, P, null);
    expect(pats(s, PIN)).toEqual([]);
    expect(pats(s, 'other.md')).toContain('pii.email');
    const h = scanHistory(repo({ [PIN]: text.replace('free', 'Free') }, true), P, ['--all'], null);
    expect(pats(h, PIN)).toContain('pii.email');
    const ok = scanHistory(repo({ [PIN]: text }, true), P, ['--all'], null);
    expect(pats(ok, PIN)).toEqual([]);
  });

  it('negative control: in history, the pinned bytes at a second path in the same commit are still scanned', async () => {
    const { loadPatterns, scanHistory } = await import('../lanes/privacy/scan.mjs');
    const P = loadPatterns(patternsWith([entry(text)]));
    // the exempt path sorts first, so a per-blob dedupe would skip the copy after the exemption let the first through
    const h = scanHistory(repo({ [PIN]: text, 'zz/copy.md': text }, true), P, ['--all'], null);
    expect(pats(h, PIN)).toEqual([]);
    expect(pats(h, 'zz/copy.md')).toContain('pii.email');
  });

  it('a malformed entry stops the gate instead of exempting anything', async () => {
    const { loadPatterns } = await import('../lanes/privacy/scan.mjs');
    expect(() => loadPatterns(patternsWith([{ path: PIN, sha256: 'not-a-hash', patterns: ['pii.email'], why: 'x' }]))).toThrow(/exempt_blobs/);
    expect(() => loadPatterns(patternsWith([{ ...entry(text), patterns: ['no.such.pattern'] }]))).toThrow(/exempt_blobs/);
    expect(() => loadPatterns(patternsWith([{ ...entry(text), patterns: [] }]))).toThrow(/exempt_blobs/);
    expect(() => loadPatterns(patternsWith([{ ...entry(text), why: '' }]))).toThrow(/exempt_blobs/);
  });

  it('the repository\'s own exemptions are the two license texts, pinned to the bytes on disk', () => {
    const p = JSON.parse(readFileSync('lanes/privacy/patterns.json', 'utf8'));
    const ex = p.exempt_blobs as { path: string; sha256: string; patterns: string[] }[];
    expect(ex.map((e) => e.path).sort()).toEqual(['companion/studio-canvas/LICENSE-tldraw.md', 'companion/studio-canvas/licenses/react-remove-scroll-bar.LICENSE']);
    for (const e of ex) {
      expect(e.patterns).toEqual(['pii.email']);
      expect(existsSync(e.path)).toBe(true);
      expect(sha(readFileSync(e.path))).toBe(e.sha256);
    }
    const build = readFileSync('scripts/canvas/build.mjs', 'utf8');
    expect(build).toContain(ex.find((e) => e.path.endsWith('LICENSE-tldraw.md'))!.sha256);
  });
});
