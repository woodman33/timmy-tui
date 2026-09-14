// ORDER blank-slate-v1k9: the first run is blank, identity terms are hashed, the journal is sanitized.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('blank-slate-v1k9', () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'timmy-blank-slate.'));
    process.env.TIMMY_HOME = join(scratch, 'home', 'timmy');
    process.env.TIMMY_PRIVATE_DIR = join(scratch, 'repo', '.timmy', 'private');
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    delete process.env.TIMMY_HOME;
    delete process.env.TIMMY_PRIVATE_DIR;
  });

  it('is a blank slate before init; without a TTY the wizard is shown and nothing is written', async () => {
    const { isBlankSlate, runInit, BANNER } = await import('../src/utils/init.js');
    expect(isBlankSlate()).toBe(true);
    const lines: string[] = [];
    const code = await runInit([], { isTTY: false, log: (s) => lines.push(s) });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(BANNER);
    expect(existsSync(process.env.TIMMY_HOME!)).toBe(false);
    expect(existsSync(process.env.TIMMY_PRIVATE_DIR!)).toBe(false);
  });

  it('init --yes writes only under TIMMY_HOME and TIMMY_PRIVATE_DIR, with a 0600 seed', async () => {
    const { applyInit, isBlankSlate } = await import('../src/utils/init.js');
    const repo = join(scratch, 'repo'); mkdirSync(repo, { recursive: true }); writeFileSync(join(repo, 'package.json'), '{"name":"t"}');
    const r = applyInit({ yes: true, json: false, operator: 'test operator', project: 'p1', seed: 'generate' }, repo);
    expect(r.ok).toBe(true);
    // the receipts store pin is generated on the first run (gitignored .timmy/), never committed
    expect(r.store_pin).toBe(join(repo, '.timmy', 'store-pin'));
    expect(readFileSync(r.store_pin!, 'utf8')).toBe(join(repo, '.timmy', 'receipts'));
    for (const w of r.written) expect(w.startsWith(process.env.TIMMY_HOME!) || w.startsWith(process.env.TIMMY_PRIVATE_DIR!) || w === r.store_pin).toBe(true);
    expect(isBlankSlate()).toBe(false);
    const id = JSON.parse(readFileSync(join(process.env.TIMMY_HOME!, 'identity.json'), 'utf8'));
    expect(id.operator_id).toMatch(/^op_[0-9a-f]{16}$/);
    expect(statSync(join(process.env.TIMMY_HOME!, 'identity.seed')).mode & 0o777).toBe(0o600);
    const cfg = JSON.parse(readFileSync(join(process.env.TIMMY_PRIVATE_DIR!, 'config.json'), 'utf8'));
    expect(cfg.operator_label).toBe('test operator');
    expect(cfg.first_project).toBe('p1');
  });

  it('a 64-hex seed imports deterministically; generate differs every time', async () => {
    const { seedIdentity } = await import('../src/utils/init.js');
    const hex = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
    expect(seedIdentity(hex).operatorId).toBe(seedIdentity(hex).operatorId);
    expect(seedIdentity('generate').operatorId).not.toBe(seedIdentity('generate').operatorId);
    expect(() => seedIdentity('not-a-seed')).toThrow();
  });

  it('hashed identity terms trip the scanner and are sanitized out of the journal', async () => {
    const { loadPatterns, scanText, hashTerm } = await import('../lanes/privacy/scan.mjs');
    const { renderJournal } = await import('../lanes/privacy/journal.mjs');
    const P = loadPatterns();
    // the synthetic term and a home path are assembled here so this test file carries no literal the gate blocks
    const term = ['planted', 'identity', 'term'].join('-');
    const home = ['', 'Users', 'someone', 'x'].join('/');
    expect(scanText(`user ${term} here`, 't', P, 'x').map((f) => f.pattern)).toContain('identity.fixture');
    expect(scanText(`svc.${term}.workers.dev`, 't', P, 'x').map((f) => f.pattern)).toContain('identity.fixture');
    expect(hashTerm(term.toUpperCase() + ' ')).toBe(hashTerm(term));
    const md = renderJournal(`ORD-1 | 2026-01-01T00:00:00Z | me | see ${home} and ${term} | f`, P);
    expect(md).toContain('[pii.home_path]');
    expect(md).toContain('[identity.fixture]');
    expect(md).not.toContain(term);
    expect(md).not.toContain(home);
  });

  it('the public pattern file stores identity only as sha256 (or an inert null placeholder)', () => {
    const p = JSON.parse(readFileSync('lanes/privacy/patterns.json', 'utf8'));
    expect(p.hashed_terms.length).toBeGreaterThan(5);
    for (const t of p.hashed_terms) expect(t.sha256 === null || /^[0-9a-f]{64}$/.test(t.sha256)).toBe(true);
    expect(p.patterns.some((x: { id: string }) => x.id === 'pii.login_name')).toBe(false);
  });
});
