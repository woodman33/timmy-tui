/**
 * Pi Durable S1 (R4 H118), plan i.3: interrupted side effects. REAL: Pi worker processes started by the supervisor,
 * SIGKILL, pi-durable 1.1.0's recovery ("interrupted and may have partially run"), the effect ledger
 * (.timmy/private/pi/effects.jsonl), the reconciler, the guard hooks and the host abort, project files and their
 * sha256. FAKE: the model (pi-ai's scripted faux provider; this script repeats a refused call as H115's looping model
 * did, spike A1) and the fixture projects. The reconciler's three outcomes are also checked in this process, on a
 * ledger written by hand (no worker).
 *
 * - A compare-and-set write killed after the write and before `ended` reconciles by sha256 to `ended (observed)`.
 * - The model repeating an interrupted write whose outcome is unknown (the file now has neither the old nor the new
 *   bytes) is refused by the guard: one effect (A0 had two without the guard; A3 one with it), and the run is aborted at
 *   that first refusal (A2): the FAKE model gets no request after it, though its script would repeat forever (A1).
 * - A trial shell killed mid-command (S1's trial_shell fixture, a real program run as argv in the run's trial folder):
 *   its ledger entry stays `started` through the kill; the restart makes it `unknown` (NEEDS YOU, with the command and
 *   its output so far), never `ended`; the FAKE model's repeat is refused and the run stops there. S6 replaces the
 *   empty trial folder with a disposable copy of the project.
 * - The same command stopped by a pause or by Timmy's exit (pi-durable's Harness.close aborts the call; the command
 *   gets SIGTERM): the tool itself records `unknown` with a NEEDS YOU, never `ended`, so at Resume the repeat is refused
 *   and the command never runs a second time without a person (fix B1 of H119's review: it was recorded `ended`, and
 *   the repeat ran).
 * - An effect's key names the real file, relative to the project's real folder (fix S6 of H119's review): a link alias,
 *   a dotted spelling or a linked folder keys as the file it leads to, so the FAKE model's repeat of a write of unknown
 *   outcome under another name is refused too (it went through before, and wrote the file again without a person).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EffectLedger, effectKey } from '../src/pi-durable/effects.js';
import { EFFECT_TOOLS } from '../src/pi-durable/guard.js';
import { piPaths } from '../src/pi-durable/paths.js';
import { reconcileOpen } from '../src/pi-durable/reconcile.js';
import { alive, anyAlive, cleanup, delegate, effects, ended, fauxCalls, INSTALLED, killWorker, project, sha, SKIP_WHY, sleep, start, status, track, until } from './helpers/pi-durable.js';

vi.setConfig({ testTimeout: 180_000 }); // worker starts and restarts, under a loaded suite
const dirs: string[] = [];
afterAll(() => { cleanup(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('the reconciler, on a ledger written by hand (no worker, no model)', () => {
  it('ends an effect observed written, ends one observed not written, and marks unknown one with third bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-durable-reconcile-'));
    dirs.push(root);
    const ledger = new EffectLedger(piPaths(root).effects);
    const open = (target: string, run: string) => ledger.append({ key: effectKey('slow_write', target, run), run, tool: 'slow_write', target, state: 'started', expected_sha256: sha('old'), new_sha256: sha('new'), by: 'tool' });
    writeFileSync(join(root, 'written.txt'), 'new');
    writeFileSync(join(root, 'unwritten.txt'), 'old');
    writeFileSync(join(root, 'other.txt'), 'someone else');
    open('written.txt', 'aaaaaaaa');
    open('unwritten.txt', 'aaaaaaaa');
    open('other.txt', 'aaaaaaaa');
    ledger.append({ key: effectKey('slow_write', 'closed.txt', 'aaaaaaaa'), run: 'aaaaaaaa', tool: 'slow_write', target: 'closed.txt', state: 'ended', by: 'tool' });
    const out = reconcileOpen(ledger, root);
    expect(out.map((r) => [r.key.split(':')[1], r.state])).toEqual([['written.txt', 'ended'], ['unwritten.txt', 'ended'], ['other.txt', 'unknown']]);
    expect(out[0].outcome).toMatch(/new bytes \(the write happened\)/);
    expect(out[1].outcome).toMatch(/old bytes \(the write did not happen\)/);
    expect(out[2].outcome).toMatch(/neither the old nor the new bytes: NEEDS YOU/);
    expect(ledger.open()).toEqual([]);
    expect(ledger.unreconciled(effectKey('slow_write', 'other.txt', 'aaaaaaaa'))?.state).toBe('unknown');
    expect(ledger.unreconciled(effectKey('slow_write', 'written.txt', 'aaaaaaaa'))).toBeUndefined();
    // a second pass finds nothing open: reconciliation appends once
    expect(reconcileOpen(ledger, root)).toEqual([]);
  });

  it('an effect\'s key names the real file: a link alias, a dotted spelling, a linked folder and a linked project folder key as what they lead to (S6)', () => {
    const real = mkdtempSync(join(tmpdir(), 'pi-durable-keys-'));
    const outside = mkdtempSync(join(tmpdir(), 'pi-durable-keys-link-'));
    dirs.push(real, outside);
    writeFileSync(join(real, 'a.txt'), 'x');
    symlinkSync('a.txt', join(real, 'alias.txt'));
    mkdirSync(join(real, 'real-folder'));
    symlinkSync('real-folder', join(real, 'folder-link'));
    const rootLink = join(outside, 'project-link');
    symlinkSync(real, rootLink);
    const keyOf = (root: string, path: string): string | undefined => EFFECT_TOOLS.slow_write(root, { path }, 'aaaaaaaa');
    expect(keyOf(real, 'a.txt')).toBe('a.txt');
    expect(keyOf(real, 'alias.txt')).toBe('a.txt');
    expect(keyOf(real, './x/../alias.txt')).toBe('a.txt');
    expect(keyOf(real, 'folder-link/new.txt')).toBe('real-folder/new.txt');
    expect(keyOf(rootLink, 'alias.txt')).toBe('a.txt');
    expect(keyOf(rootLink, 'folder-link/new.txt')).toBe('real-folder/new.txt');
  });
});

describe.skipIf(!INSTALLED)(`interrupted side effects through the worker (plan i.3)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  const script = (delay: number) => ({
    first: { tool: 'slow_write', args: { path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes'), delay_ms: delay } },
    after_interrupted: 'repeat' as const,
    after_blocked: 'repeat' as const, // a model that keeps repeating a refused call (spike A1)
  });

  it('a compare-and-set write killed after the write and before `ended` reconciles by sha256 to ended (observed)', async () => {
    const root = project('effects-reconcile', { 'a.txt': 'old bytes' });
    const a = await start(root);
    const d = await delegate(a.client, script(15_000));
    await until('the write, before its end', () => effects(root, d.run).some((e) => e.state === 'started') && readFileSync(join(root, 'a.txt'), 'utf8') === 'new bytes');
    a.client.close();
    await killWorker(root);
    const before = effects(root, d.run);
    expect(before.map((e) => e.state)).toEqual(['started']);
    expect(before[0]).toMatchObject({ key: effectKey('slow_write', 'a.txt', d.run), expected_sha256: sha('old bytes'), new_sha256: sha('new bytes') });

    const b = await start(root); // reconciliation runs at start, before anything is scheduled
    const after = effects(root, d.run);
    expect(after.map((e) => `${e.state}/${e.by}`)).toEqual(['started/tool', 'ended/reconcile']);
    expect(after[1].outcome).toBe('observed after a restart: the file has the new bytes (the write happened)');
    expect(after[1].readback).toEqual({ sha256: sha('new bytes') });
    expect((await status(b.client, d.run)).needs_you).toEqual([]);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('the model repeating an interrupted write of unknown outcome is refused: one effect, and the run is aborted at the first refusal (A3, A2)', async () => {
    const root = project('effects-block', { 'a.txt': 'old bytes' });
    const a = await start(root);
    const d = await delegate(a.client, script(15_000));
    await until('the write, before its end', () => effects(root, d.run).some((e) => e.state === 'started') && readFileSync(join(root, 'a.txt'), 'utf8') === 'new bytes');
    a.client.close();
    await killWorker(root);
    // while no worker runs, the file changes again: neither the old bytes nor the new
    writeFileSync(join(root, 'a.txt'), 'third bytes');
    const callsBefore = fauxCalls(root, d.run).length;

    const b = await start(root);
    const paused = await status(b.client, d.run);
    expect(paused.effects.at(-1)).toMatchObject({ state: 'unknown', by: 'reconcile', readback: { sha256: sha('third bytes') } });
    expect(paused.needs_you).toHaveLength(1);
    expect(paused.needs_you[0].why).toMatch(/neither the old nor the new bytes: NEEDS YOU/);

    await b.client.request('resume');
    const end = await ended(b.client, d.run);
    expect(end.status).toBe('needs you');
    expect(end.submission).toMatchObject({ status: 'unanswered', reason: 'aborted' });
    const results = end.entries.filter((e) => e.kind === 'pi.tool-result').map((e) => e.text);
    expect(results[0]).toMatch(/Tool slow_write was interrupted and may have partially run/);
    expect(results.filter((t) => /Tool call blocked: NEEDS YOU/.test(t))).toHaveLength(1); // refused once, not 12 times (A1)
    // after the restart the FAKE model was asked exactly once (its repeat); nothing after the refusal
    const after = fauxCalls(root, d.run).slice(callsBefore);
    expect(after).toHaveLength(1);
    expect(after[0].last_text).toMatch(/was interrupted/);
    // one effect: the original write's `started`, never a second
    expect(effects(root, d.run).filter((e) => e.state === 'started')).toHaveLength(1);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('third bytes');
    expect(end.needs_you.length).toBeGreaterThanOrEqual(2); // the reconcile's unknown, then the refusal
    expect(end.needs_you.at(-1)?.why).toMatch(/^NEEDS YOU: an earlier slow_write of a\.txt in this run is of unknown outcome/);
    await sleep(500);
    expect(fauxCalls(root, d.run).slice(callsBefore)).toHaveLength(1);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('the model repeating a write of unknown outcome under a link alias is refused as the same effect: the file is not written again (S6)', async () => {
    const root = project('effects-alias', { 'a.txt': 'old bytes' });
    symlinkSync('a.txt', join(root, 'alias.txt'));
    const a = await start(root);
    // its repeat names the same file by its alias, with the compare-and-set hash of the bytes the file will have then
    const d = await delegate(a.client, {
      first: { tool: 'slow_write', args: { path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes'), delay_ms: 15_000 } },
      after_interrupted: { tool: 'slow_write', args: { path: 'alias.txt', content: 'alias bytes', expected_sha256: sha('third bytes') } },
      after_blocked: { text: 'Stopped: the earlier write needs a person (FAKE answer).' },
    });
    await until('the write, before its end', () => effects(root, d.run).some((e) => e.state === 'started') && readFileSync(join(root, 'a.txt'), 'utf8') === 'new bytes');
    a.client.close();
    await killWorker(root);
    writeFileSync(join(root, 'a.txt'), 'third bytes'); // neither the old nor the new bytes: unknown at the restart

    const b = await start(root);
    expect(effects(root, d.run).map((e) => `${e.state}/${e.by}`)).toEqual(['started/tool', 'unknown/reconcile']);
    await b.client.request('resume');
    const end = await ended(b.client, d.run);
    expect(end.status).toBe('needs you');
    const results = end.entries.filter((e) => e.kind === 'pi.tool-result').map((e) => e.text);
    expect(results).toEqual([
      expect.stringMatching(/Tool slow_write was interrupted and may have partially run/),
      expect.stringMatching(/Tool call blocked: NEEDS YOU: an earlier slow_write of a\.txt in this run is of unknown outcome/),
    ]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('third bytes'); // not written again under its alias
    expect(effects(root, d.run).filter((e) => e.state === 'started')).toHaveLength(1);
    expect(effects(root).map((e) => e.key)).toEqual([`slow_write:a.txt:${d.run}`, `slow_write:a.txt:${d.run}`]);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('a trial shell killed mid-command: its entry stays started; the restart makes it NEEDS YOU unknown, never ended; the repeat is refused (i.3)', async () => {
    const root = project('effects-shell');
    const a = await start(root, { worker: { trialShell: true } });
    // a real program, run by the worker as argv: it prints, then would print again after 8 s
    const argv = [process.execPath, '-e', "process.stdout.write('partial output\\n'); setTimeout(() => process.stdout.write('late output\\n'), 8000)"];
    const d = await delegate(a.client, { first: { tool: 'trial_shell', args: { argv } }, after_interrupted: 'repeat', after_blocked: 'repeat' });
    expect(d.ok).toBe(true);
    const out = await until('the command to have printed', () => {
      const e = effects(root, d.run).find((x) => x.state === 'started');
      return e?.output && existsSync(join(root, e.output)) && readFileSync(join(root, e.output), 'utf8').includes('partial output') ? join(root, e.output) : undefined;
    });
    const childPid = Number.parseInt(readFileSync(`${out}.pid`, 'utf8'), 10);
    track(childPid);
    a.client.close();
    await killWorker(root);
    expect(effects(root, d.run).map((e) => e.state)).toEqual(['started']);
    expect(effects(root, d.run)[0]).toMatchObject({ key: `trial_shell:.timmy/private/pi/${d.run}/trial:${d.run}`, argv });

    const b = await start(root, { worker: { trialShell: true } });
    const after = effects(root, d.run);
    expect(after.map((e) => `${e.state}/${e.by}`)).toEqual(['started/tool', 'unknown/reconcile']);
    expect(after[1].outcome).toMatch(/^trial_shell was interrupted mid-command; what a command did cannot be read back: NEEDS YOU\. The command: /);
    expect(after[1].outcome).toContain('partial output');
    if (alive(childPid)) expect(after[1].outcome).toContain(`A process with its pid (${childPid}) still runs`);
    const paused = await status(b.client, d.run);
    expect(paused.status).toBe('interrupted');
    expect(paused.needs_you.map((n) => n.key)).toEqual([after[0].key]);

    await b.client.request('resume');
    const end = await ended(b.client, d.run);
    expect(end.status).toBe('needs you');
    expect(end.entries.filter((e) => e.kind === 'pi.tool-result').map((e) => e.text)).toEqual([
      expect.stringMatching(/Tool trial_shell was interrupted and may have partially run/),
      expect.stringMatching(/Tool call blocked: NEEDS YOU: an earlier trial_shell/),
    ]);
    const final = effects(root, d.run);
    expect(final.filter((e) => e.state === 'started')).toHaveLength(1); // the command ran once
    expect(final.some((e) => e.state === 'ended')).toBe(false); // never ended
    await b.client.request('shutdown');
    b.client.close();
    if (alive(childPid)) process.kill(childPid, 'SIGKILL'); // the command the test caused, by its pid
  });

  /** A run whose trial_shell command is running (it printed, and would print again after 8 s). */
  async function shellRunning(name: string): Promise<{ root: string; a: Awaited<ReturnType<typeof start>>; run: string; out: string; childPid: number }> {
    const root = project(name);
    const a = await start(root, { worker: { trialShell: true } });
    const argv = [process.execPath, '-e', "process.stdout.write('partial output\\n'); setTimeout(() => process.stdout.write('late output\\n'), 8000)"];
    const d = await delegate(a.client, { first: { tool: 'trial_shell', args: { argv } }, after_interrupted: 'repeat', after_blocked: 'repeat' });
    expect(d.ok).toBe(true);
    const out = await until('the command to have printed', () => {
      const e = effects(root, d.run).find((x) => x.state === 'started');
      return e?.output && existsSync(join(root, e.output)) && readFileSync(join(root, e.output), 'utf8').includes('partial output') ? join(root, e.output) : undefined;
    });
    const childPid = Number.parseInt(readFileSync(`${out}.pid`, 'utf8'), 10);
    track(childPid);
    return { root, a, run: d.run, out, childPid };
  }

  /** The stopped command's ledger: `started`, then the tool's own `unknown` with the exit, the output's sha256 and its tail. */
  function expectUnknownByTool(root: string, run: string, out: string): string {
    const ledger = effects(root, run);
    expect(ledger.map((e) => `${e.state}/${e.by}`)).toEqual(['started/tool', 'unknown/tool']);
    expect(ledger[1].outcome).toMatch(/^stopped by its abort signal \(ended by SIGTERM\): what the command did cannot be read back: NEEDS YOU\. The command: /);
    expect(ledger[1].outcome).toContain('partial output');
    expect(ledger[1].readback).toEqual({ sha256: sha(readFileSync(out)) });
    expect(ledger[1].exit).toBeNull();
    return ledger[0].key;
  }

  /** At Resume: the FAKE model's repeat is refused, the run stops at that refusal, and the command ran once, never ended. */
  async function expectRepeatRefused(client: Awaited<ReturnType<typeof start>>['client'], root: string, run: string): Promise<void> {
    await client.request('resume');
    const end = await ended(client, run);
    expect(end.status).toBe('needs you');
    expect(end.entries.filter((e) => e.kind === 'pi.tool-result').map((e) => e.text)).toEqual([
      expect.stringMatching(/Tool trial_shell was interrupted and may have partially run/),
      expect.stringMatching(/Tool call blocked: NEEDS YOU: an earlier trial_shell of \.timmy\/private\/pi\/[0-9a-f]{8}\/trial in this run is of unknown outcome/),
    ]);
    const final = effects(root, run);
    expect(final.filter((e) => e.state === 'started')).toHaveLength(1); // the command ran once
    expect(final.some((e) => e.state === 'ended')).toBe(false); // never ended
  }

  it('a trial shell stopped by a pause: the tool records unknown with a NEEDS YOU, not ended; at Resume the repeat is refused and the command never runs again (B1)', async () => {
    const { root, a, run, out, childPid } = await shellRunning('effects-shell-pause');
    expect(await a.client.request<{ scheduling: string; runs: string[] }>('pause')).toEqual({ scheduling: 'paused', runs: [run] });
    expect(alive(childPid)).toBe(false); // the abort ended the command (SIGTERM)
    const key = expectUnknownByTool(root, run, out);
    const paused = await status(a.client, run);
    expect(paused.needs_you.map((n) => n.key)).toEqual([key]);
    expect(paused.needs_you[0].why).toMatch(/^stopped by its abort signal \(ended by SIGTERM\): what the command did cannot be read back: NEEDS YOU/);
    await expectRepeatRefused(a.client, root, run);
    await a.client.request('shutdown');
    a.client.close();
  });

  it('a trial shell stopped by Timmy\'s exit (shutdown, pause on exit): the tool records unknown with a NEEDS YOU; the next worker refuses the repeat (B1)', async () => {
    const { root, a, run, out, childPid } = await shellRunning('effects-shell-exit');
    const pid = a.client.hello.pid;
    await a.client.request('shutdown');
    a.client.close();
    await until('the worker to exit', () => !alive(pid), 30_000, 50);
    expect(alive(childPid)).toBe(false);
    const key = expectUnknownByTool(root, run, out);
    const b = await start(root, { worker: { trialShell: true } });
    expect(b.client.hello.scheduling).toBe('paused');
    expect(effects(root, run)).toHaveLength(2); // nothing to reconcile: the tool's own record is already unknown
    const paused = await status(b.client, run);
    expect(paused.status).toBe('paused');
    expect(paused.needs_you.map((n) => n.key)).toEqual([key]);
    await expectRepeatRefused(b.client, root, run);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('leaves no worker running: every worker this file started has exited (shut down, or killed by the test on purpose)', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
