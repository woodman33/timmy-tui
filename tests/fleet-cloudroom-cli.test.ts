/**
 * Round R4 (lead): Cloudroom through the shipped CLI, end to end and offline. REAL: `timmy fleet connect`, the config and
 * its 0600 token-file rule, the provider list, the plan's checks, the CLI's approval flow, the scheduler, the adapted
 * Cloudroom client over real HTTP, receipts and the run detail. FAKE: the Cloudroom Core (src/fleet/cloudroom/fake-core.ts,
 * started by this test on 127.0.0.1, or by the CLI itself under TIMMY_FLEET_CLOUDROOM=fake): no harness, no model, no VM.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeCore, type FakeCore } from '../src/fleet/cloudroom/index.js';

const REPO = path.resolve(__dirname, '..');
const LOADER = pathToFileURL(path.join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const CLI = path.join(REPO, 'src', 'cli.ts');
const roots: string[] = [];
let core: FakeCore;
beforeAll(async () => { core = await startFakeCore(); });
afterAll(async () => { await core.close(); for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function project(): { root: string; home: string } {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cr-cli-'));
  roots.push(top);
  const root = path.join(top, 'proj');
  fs.mkdirSync(root);
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=fake', '-c', 'user.name=FAKE', ...a], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'FAKE');
  return { root, home: path.join(top, 'home') };
}
function cli(p: { root: string; home: string }, env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(process.execPath, ['--import', LOADER, CLI, ...args], {
    cwd: p.root, encoding: 'utf8', timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: p.home, TIMMY_HOME: path.join(p.home, 'timmy'), TIMMY_SETTINGS_DIR: path.join(p.home, 'settings'), TMPDIR: process.env.TMPDIR, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, last: (): Record<string, unknown> => JSON.parse(r.stdout.trim().split('\n').pop()!) };
}
/**
 * The CLI without blocking this process: the FAKE Core this test started lives here, so a synchronous child would
 * wait on a server that cannot answer until the child ends.
 */
function cliAsync(p: { root: string; home: string }, env: Record<string, string>, ...args: string[]): Promise<{ code: number | null; out: string; err: string; last: () => Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--import', LOADER, CLI, ...args], {
      cwd: p.root,
      env: { PATH: process.env.PATH, HOME: p.home, TIMMY_HOME: path.join(p.home, 'timmy'), TIMMY_SETTINGS_DIR: path.join(p.home, 'settings'), TMPDIR: process.env.TMPDIR, ...env },
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    c.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    const timer = setTimeout(() => { c.kill('SIGKILL'); reject(new Error(`timed out: timmy ${args.join(' ')}\n${out}\n${err}`)); }, 120_000);
    c.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, last: () => JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown> }); });
  });
}
/** Every file under a folder, as text (for the token check). */
function allText(dir: string): string {
  let out = '';
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    out += e.isDirectory() ? allText(f) : fs.readFileSync(f, 'utf8');
  }
  return out;
}
/** A person's approval for an agent's run: the hash the refusal names, minted by `timmy approve` (no Core is contacted). */
function approve(p: { root: string; home: string }, env: Record<string, string>, refusal: string): string {
  const hash = /timmy approve ([0-9a-f]{32})/.exec(refusal)?.[1];
  expect(hash, refusal).toBeDefined();
  const minted = cli(p, env, 'approve', hash!);
  const token = /approval ([0-9a-f]{32})/.exec(minted.out)?.[1];
  expect(token, minted.out + minted.err).toBeDefined();
  return token!;
}

describe('timmy fleet connect cloudroom', () => {
  it('refuses a token file others can read, records a 0600 one without reading it, and turns nothing on by itself', () => {
    const p = project();
    const tokenFile = path.join(p.home, 'cloudroom.token');
    fs.mkdirSync(p.home, { recursive: true });
    fs.writeFileSync(tokenFile, `${core.token}\n`, { mode: 0o644 });
    fs.chmodSync(tokenFile, 0o644);
    const loose = cli(p, {}, 'fleet', 'connect', 'cloudroom', core.url, '--token-file', tokenFile);
    expect(loose.code).toBe(1);
    expect(loose.out).toMatch(/allows group or other access .*make it 0600/);
    fs.chmodSync(tokenFile, 0o600);
    const ok = cli(p, {}, 'fleet', 'connect', 'cloudroom', core.url, '--token-file', tokenFile, '--label', 'fake-lab', '--max-concurrent', '3');
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toMatch(/Recorded: the Cloudroom Core at .*"fake-lab"/);
    expect(ok.out).toMatch(/Nothing was contacted/);
    expect(allText(path.join(p.home, 'timmy'))).not.toContain(core.token);
    // the flag is still off: the provider list says so, and nothing reached the Core
    const before = core.calls.length;
    const list = cli(p, {}, 'fleet', 'providers');
    expect(list.out).toMatch(/unavailable cloudroom +Cloudroom Core: .* TIMMY_FLEET_CLOUDROOM is not set/);
    expect(core.calls.length).toBe(before);
  });
});

describe('a fleet on a Cloudroom Core through the CLI (the Core is FAKE)', () => {
  it('TIMMY_FLEET_CLOUDROOM=1: plan shared sessions, refuse a VM per worker, run with a minted approval, read it back', async () => {
    const p = project();
    const tokenFile = path.join(p.home, 'cloudroom.token');
    fs.mkdirSync(p.home, { recursive: true });
    fs.writeFileSync(tokenFile, core.token, { mode: 0o600 });
    expect(cli(p, {}, 'fleet', 'connect', 'cloudroom', core.url, '--token-file', tokenFile, '--max-concurrent', '3').code).toBe(0);
    const on = { TIMMY_FLEET_CLOUDROOM: '1' };
    expect(cli(p, on, 'fleet', 'providers').out).toMatch(/available +cloudroom +Cloudroom Core/);
    // one VM per worker is not what a shared Core gives: refused in words, nothing written
    const vm = await cliAsync(p, on, 'fleet', 'plan', '--provider', 'cloudroom', '--workers', '4', '--prompt', 'FAKE task', '--json');
    expect(vm.code).toBe(1);
    expect(vm.out).toMatch(/cannot give a virtual machine .*it offers: shared-session.*refused rather than run with less/);
    const wordless = await cliAsync(p, on, 'fleet', 'plan', '--provider', 'cloudroom', '--isolation', 'shared-session', '--workers', '2', '--json');
    expect(wordless.code).toBe(1);
    expect(wordless.out).toMatch(/each task needs words \(--prompt TEXT\)/);
    // a session on a shared machine is: planned, said so, not a simulation (the Core is real HTTP; this one is FAKE)
    const plan = await cliAsync(p, on, 'fleet', 'plan', '--provider', 'cloudroom', '--isolation', 'shared-session', '--workers', '6', '--concurrency', '3', '--prompt', 'FAKE task', '--json');
    expect(plan.code, plan.out + plan.err).toBe(0);
    expect(plan.out).toMatch(/each a session on a shared machine/);
    expect(plan.out).not.toMatch(/SIMULATION/);
    const planId = String(plan.last().plan);
    // an agent (no terminal) needs a person's token; the run then goes through the adapter to the Core
    const refused = await cliAsync(p, on, 'fleet', 'run', planId, '--json');
    expect(refused.code).toBe(1);
    const token = approve(p, on, refused.out);
    const sessionsBefore = core.sessionIds().length;
    const ran = await cliAsync(p, on, 'fleet', 'run', planId, '--approve', token, '--json');
    expect(ran.code, ran.out + ran.err).toBe(0);
    expect(ran.last()).toMatchObject({ status: 'finished', counts: { delivered: 6, verified: 0 }, simulation: false });
    expect(core.sessionIds().length - sessionsBefore).toBe(6);
    expect(core.fallbacks()).toBe(0);
    const status = cli(p, on, 'fleet', 'status', planId);
    expect(status.out).toMatch(/delivered 6 \(not verified\)/);
    expect(status.out).toMatch(/Cloudroom Core/);
    // the token never reached the project's files, the receipts or the config
    expect(allText(path.join(p.root, '.timmy'))).not.toContain(core.token);
    expect(allText(path.join(p.home, 'timmy'))).not.toContain(core.token);
  }, 180_000);

  it('TIMMY_FLEET_CLOUDROOM=fake: provider cloudroom-fake, labelled a simulation on every line, its FAKE Core inside the run', () => {
    const p = project();
    const fake = { TIMMY_FLEET_CLOUDROOM: 'fake' };
    const list = cli(p, fake, 'fleet', 'providers');
    expect(list.out).toMatch(/available +cloudroom-fake +FAKE Cloudroom Core/);
    expect(list.out).toMatch(/unavailable cloudroom +Cloudroom Core: .*only the FAKE Core \(provider cloudroom-fake\)/);
    const plan = cli(p, fake, 'fleet', 'plan', '--provider', 'cloudroom-fake', '--isolation', 'shared-session', '--workers', '5', '--concurrency', '2', '--prompt', 'FAKE task', '--json');
    expect(plan.code, plan.out + plan.err).toBe(0);
    expect(plan.out).toMatch(/SIMULATION on the FAKE Cloudroom Core \(real HTTP to a FAKE Core on this computer\)/);
    const planId = String(plan.last().plan);
    const token = approve(p, fake, cli(p, fake, 'fleet', 'run', planId, '--json').out);
    const ran = cli(p, fake, 'fleet', 'run', planId, '--approve', token, '--json');
    expect(ran.code, ran.out + ran.err).toBe(0);
    expect(ran.last()).toMatchObject({ status: 'finished', counts: { delivered: 5, verified: 0 }, simulation: true });
    // its FAKE Core lived in the run's process: another process has nothing to reconcile from it, and says so
    const rec = cli(p, fake, 'fleet', 'reconcile', planId);
    expect(rec.code).toBe(1);
    expect(rec.out).toMatch(/lives only inside the process that ran the plan/);
  }, 180_000);
});
