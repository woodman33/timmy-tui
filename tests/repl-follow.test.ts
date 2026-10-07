import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendReceipt, receiptsPath } from '../src/utils/receipts.js';

// C-8: `timmy receipts` verifies the chain, then lists the latest receipts, inline and append-only;
// `--follow` keeps printing each new receipt as it is sealed, until Ctrl+C (130). A broken chain is
// said in red with ✖ and exits 65 (bad data); green is only for a chain that verified.
const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const dirs: string[] = [];
const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-follow-'));
  dirs.push(dir);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, TIMMY_STORE: join(dir, '.timmy', 'receipts'), NO_COLOR: '1', NODE_ENV: '' };
  // timmy init so the blank-slate wizard does not answer instead
  spawnSync(TSX, [CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo'], { cwd: dir, env, encoding: 'utf8' });
  return { dir, env };
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const seal = (dir: string, subject: string) => appendReceipt('runs', { kind: 'turn', subject, policy: 'human-gated', status: 'ok' }, dir).hash.slice(7, 15);

describe('timmy receipts', () => {
  it('verifies the chain, then lists the latest receipts, and exits 0', () => {
    const { dir, env } = sandbox();
    const a = seal(dir, 'repl · 1 step');
    const b = seal(dir, 'repl · 2 steps');
    const r = spawnSync(TSX, [CLI, 'receipts'], { cwd: dir, env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[OK\] Chain verified\s+2 receipts|✓ Chain verified\s+2 receipts/);
    expect(r.stdout.indexOf(a)).toBeGreaterThan(-1);
    expect(r.stdout.indexOf(b)).toBeGreaterThan(r.stdout.indexOf(a));
  });
  it('says a broken chain plainly and exits 65', () => {
    const { dir, env } = sandbox();
    seal(dir, 'repl · 1 step');
    const p = receiptsPath('runs', dir);
    writeFileSync(p, readFileSync(p, 'utf8').replace('repl', 'REPL'));
    const r = spawnSync(TSX, [CLI, 'receipts'], { cwd: dir, env, encoding: 'utf8' });
    expect(r.status).toBe(65);
    expect(r.stdout).toMatch(/Chain broken/);
    expect(r.stdout).not.toMatch(/Chain verified/);
  });
  it('--follow prints each new receipt as it is sealed, and Ctrl+C ends it with 130', async () => {
    const { dir, env } = sandbox();
    const first = seal(dir, 'repl · 1 step');
    const child = spawn(TSX, [CLI, 'receipts', '--follow'], { cwd: dir, env });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const until = async (re: RegExp) => {
      for (let i = 0; i < 200 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 50));
      if (!re.test(out)) throw new Error(`timed out waiting for ${re}:\n${out}`);
    };
    await until(new RegExp(first));
    const next = seal(dir, 'repl · 3 steps');
    await until(new RegExp(next));
    const code = await new Promise<number | null>((r) => { child.on('exit', (c) => r(c)); child.kill('SIGINT'); });
    expect(code).toBe(130);
    expect(out.indexOf(next)).toBeGreaterThan(out.indexOf(first));
  }, 60_000);
});

// C-15 (playbook §19.5): `--json` gives one stable envelope and `--quiet` bare values, for scripts.
describe('timmy receipts for scripts', () => {
  const chain = [
    { hash: 'sha256:aaaaaaaa11111111', kind: 'turn', subject: 'repl · 1 step', ts: '2026-10-07T07:00:00.000Z' },
    { hash: 'sha256:bbbbbbbb22222222', kind: 'check', subject: 'setup check', ts: '2026-10-07T07:01:00.000Z' },
  ];
  const run = async (format: 'json' | 'quiet', ok = true) => {
    const { showReceipts } = await import('../src/repl/follow.js');
    const { buildTheme } = await import('../src/term/theme.js');
    const { detectCapabilities } = await import('../src/term/capabilities.js');
    const tty = { isTTY: false, columns: 80, rows: 24 };
    const out: string[] = [];
    const code = await showReceipts({
      follow: false, last: 10, format, write: (l) => out.push(l),
      theme: buildTheme(detectCapabilities({ env: {}, stdin: tty, stdout: tty, stderr: tty })),
      read: () => chain as never, verify: () => (ok ? { ok: true, count: 2 } : { ok: false, count: 2, reason: 'hash mismatch at 2' }),
    });
    return { code, out };
  };
  it('--json prints one envelope: ok, verified, count and the receipts', async () => {
    const { code, out } = await run('json');
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toEqual({
      ok: true, verified: true, count: 2,
      receipts: [
        { hash: 'sha256:aaaaaaaa11111111', kind: 'turn', subject: 'repl · 1 step', at: '2026-10-07T07:00:00.000Z' },
        { hash: 'sha256:bbbbbbbb22222222', kind: 'check', subject: 'setup check', at: '2026-10-07T07:01:00.000Z' },
      ],
    });
  });
  it('--json says a broken chain in the envelope and exits 65', async () => {
    const { code, out } = await run('json', false);
    expect(code).toBe(65);
    expect(JSON.parse(out[0])).toMatchObject({ ok: false, verified: false, error: 'hash mismatch at 2' });
  });
  // Fourth order, step 5: a turn that drew on Timmy Canvas names its canvas job and revision here too,
  // so the terminal shows the same job identity as the canvas and its ledger.
  it("names a turn's canvas job and revision, in the line and in --json", async () => {
    const { showReceipts } = await import('../src/repl/follow.js');
    const { buildTheme } = await import('../src/term/theme.js');
    const { detectCapabilities } = await import('../src/term/capabilities.js');
    const tty = { isTTY: false, columns: 100, rows: 24 };
    const theme = buildTheme(detectCapabilities({ env: {}, stdin: tty, stdout: tty, stderr: tty }));
    const canvasTurn = { ...chain[0], sources: [{ kind: 'timmy-canvas', job: 'turn-3c0f18b0', revision: 12, source_revision: 'ab'.repeat(32) }] };
    for (const format of ['human', 'json'] as const) {
      const out: string[] = [];
      await showReceipts({ follow: false, last: 10, format, write: (l) => out.push(l), theme, read: () => [canvasTurn, chain[1]] as never, verify: () => ({ ok: true, count: 2 }) });
      if (format === 'human') {
        expect(out.find((l) => l.includes('aaaaaaaa'))).toContain('canvas turn-3c0f18b0 at revision 12');
        expect(out.find((l) => l.includes('bbbbbbbb'))).not.toContain('canvas');
      } else {
        expect(JSON.parse(out[0]).receipts).toEqual([
          { hash: 'sha256:aaaaaaaa11111111', kind: 'turn', subject: 'repl · 1 step', at: '2026-10-07T07:00:00.000Z', canvas: { job: 'turn-3c0f18b0', revision: 12, source_revision: 'ab'.repeat(32) } },
          { hash: 'sha256:bbbbbbbb22222222', kind: 'check', subject: 'setup check', at: '2026-10-07T07:01:00.000Z' },
        ]);
      }
    }
  });
  it('--quiet prints the hashes alone, one a line', async () => {
    const { code, out } = await run('quiet');
    expect(code).toBe(0);
    expect(out).toEqual(['sha256:aaaaaaaa11111111', 'sha256:bbbbbbbb22222222']);
  });
});

describe('timmy receipts --json from the command line', () => {
  // The CLI takes --json out of its arguments for the verbs that print JSON themselves; this verb must
  // still get it (it was dropped: the dry run found plain text where the envelope belonged).
  it('prints the envelope', () => {
    const { dir, env } = sandbox();
    seal(dir, 'repl · 1 step');
    const r = spawnSync(TSX, [CLI, 'receipts', '--json'], { cwd: dir, env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, verified: true, count: 1 });
  });
});
