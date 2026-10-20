/**
 * R9 (H159): a recording's entities, timelines and time ranges read through the installed Rerun CLI (src/vox/rrd-cli.ts),
 * bounded: argv only, the recording's bytes on the program's standard input, each call in its own process group with a
 * timeout and an output cap; and each thing it cannot read stays unknown, with why.
 *
 * FAKE, labelled: `rerun` is tests/fixtures/fake-rerun.mjs (a TEST DOUBLE), put first on the PATH (or named by TIMMY_RERUN).
 * By default it replays outputs CAPTURED from the real rerun-cli 0.38.1 (tests/fixtures/rrd-cli/CAPTURED.json: the version
 * line, each command and its exit) on probe.rrd, probe-cut.rrd and edge.rrd; its other modes give a timeout, a huge output, a
 * bad exit, garbage and an unchecked version. Real: the readers in src/vox/rrd-cli.ts, the captured bytes; and, when `rerun`
 * is installed here, one test that runs the real CLI (skipped otherwise, and its title says why).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectId } from '../src/project/index.js';
import { RERUN_SETUP } from '../src/vox/layers.js';
import { readLogs } from '../src/workbench/logs-tab.js';
import {
  forgetRrdReadings, readRrdWithCli, RRD_CLI_CHECKED, RRD_CLI_OUTPUT_MAX, RRD_CLI_TIMEOUT_MS, RRD_PRINT_DATA_MAX, rrdReadingNow, rrdReadingsIdle, startRrdReading,
  type RrdCall, type RrdReading,
} from '../src/vox/rrd-cli.js';

const FIX = resolve('tests/fixtures/rrd-cli');
const FAKE = resolve('tests/fixtures/fake-rerun.mjs');
const CAPTURED = JSON.parse(readFileSync(join(FIX, 'CAPTURED.json'), 'utf8')) as { version_line: string; files: Record<string, { sha256: string; bytes: number }> };
const PROBE = readFileSync(join(FIX, 'probe.rrd'));
const CUT = readFileSync(join(FIX, 'probe-cut.rrd'));
const EDGE = readFileSync(join(FIX, 'edge.rrd'));
const bytesOf = (f: string): number => readFileSync(join(FIX, 'captured', f)).length;

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const box = (): string => { const d = mkdtempSync(join(tmpdir(), 'h159-rrd-')); made.push(d); return d; };
/** A folder holding the FAKE as `rerun` (a two-line wrapper that runs it with this node). */
function fakeBin(): string {
  const bin = box();
  writeFileSync(join(bin, 'rerun'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(bin, 'rerun'), 0o755);
  return bin;
}
const envOf = (bin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: `${bin}:/usr/bin:/bin`, ...extra });
const callsOf = (file: string): Array<{ argv: string[]; mode: string; input: string | null; ci: string | null }> =>
  (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []).map((l) => JSON.parse(l));
/** Whether a process is alive (a zombie is not: it has ended and waits only to be reaped). */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    try { process.kill(pid, 0); return !existsSync('/proc'); } catch { return false; }
  }
}
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}
const unknownAll = (r: RrdReading) => [r.entities, r.timelines];

/** What the sample holds, as the captured rerun-cli 0.38.1 printed it (tests/fixtures/rrd-cli/captured/). */
const PROBE_ENTITIES = ['/__properties', '/notes', '/world/box', '/world/points'];
const PROBE_TIMELINES = [
  {
    name: 'frame', chunks: 2, kind: { state: 'read', kind: 'sequence', type: 'Int64', by: 'rrd print -vv' },
    range: { state: 'read', min: '0', max: '7', words: '0 to 7', by: 'rrd print -vvv' },
  },
  {
    name: 'log_time', chunks: 2, kind: { state: 'read', kind: 'timestamp', type: 'Timestamp(ns)', by: 'rrd print -vv' },
    range: { state: 'read', min: '2026-10-20T12:53:49.704175155', max: '2026-10-20T12:53:49.706428498', words: '2026-10-20T12:53:49.704175155 to 2026-10-20T12:53:49.706428498 (2.253343 ms)', by: 'rrd print -vvv' },
  },
  {
    name: 't', chunks: 2, kind: { state: 'read', kind: 'duration', type: 'Duration(ns)', by: 'rrd print -vv' },
    range: { state: 'read', min: 'P0D', max: 'PT1S', words: '0 s to 1 s', by: 'rrd print -vvv' },
  },
];

describe('a recording read through the installed Rerun CLI, bounded (R9 H159)', () => {
  it('the sample through the FAKE rerun replaying rerun-cli 0.38.1\'s captured outputs: its entities, timelines and ranges, each call named and bounded', async () => {
    const bin = fakeBin();
    const log = join(box(), 'calls.jsonl');
    const seen: RrdCall[] = [];
    const r = await readRrdWithCli(PROBE, { env: envOf(bin, { FAKE_RERUN_CALLS: log, FORCE_RERUN_ANALYTICS: '1' }), onCall: (c) => seen.push(c) });
    expect(r.schema).toBe('timmy.rrd-cli/1');
    expect(r.state).toBe('read');
    expect(r.sha256).toBe(CAPTURED.files['probe.rrd'].sha256);
    expect(r.bytes).toBe(PROBE.length);
    expect(r.cli).toEqual({ version: '0.38.1', line: CAPTURED.version_line, via: 'rerun on the PATH', checked: ['0.38.1'] });
    expect(RRD_CLI_CHECKED).toEqual(['0.38.1']);
    expect(r.words).toBe('read by rerun-cli 0.38.1: rrd stats and rrd print');
    expect(r.verify).toEqual({ state: 'passed', words: 'rrd verify: 1 file verified without error.', by: 'rrd verify' });
    expect(r.entities).toEqual({
      state: 'read', count: 4, paths: PROBE_ENTITIES, by: 'rrd stats',
      stores: [{ kind: 'recording', application: 'timmy-r9-probe', recording: 'probe-1', entities: 4 }],
      static: { state: 'read', paths: ['/__properties', '/notes'], by: 'rrd print -vv' },
    });
    expect(r.timelines).toEqual({ state: 'read', by: 'rrd stats', list: PROBE_TIMELINES });
    // every call: its command (no program path), its exit, how long, how many bytes, whether it was cut
    expect(r.calls.map((c) => [c.command, c.exit, c.signal, c.timedOut, c.cut, c.bytes])).toEqual([
      ['rerun --version', 0, null, false, false, bytesOf('version.stdout')],
      ['rerun rrd verify', 0, null, false, false, bytesOf('verify.stderr')],
      ['rerun rrd stats', 0, null, false, false, bytesOf('stats.stdout') + bytesOf('stats.stderr')],
      ['rerun rrd print -vv', 0, null, false, false, bytesOf('print-vv.stdout')],
      ['rerun rrd print -vvv', 0, null, false, false, bytesOf('print-vvv.stdout')],
    ]);
    for (const c of r.calls) {
      expect(c.ms, c.command).toBeGreaterThanOrEqual(0);
      expect(c.version).toBe(c.command === 'rerun --version' ? null : '0.38.1');
      expect(c.input).toEqual(c.command === 'rerun --version' ? null : { sha256: r.sha256, bytes: PROBE.length, words: 'the recording\'s bytes on its standard input' });
      expect(c.command).not.toContain(bin);
    }
    expect(seen).toEqual(r.calls);
    // what the FAKE was given: argv arrays, the recording's own bytes, and CI=1 (Rerun's analytics are off on CI; nothing is sent)
    expect(callsOf(log).map((c) => [c.argv.join(' '), c.input, c.ci])).toEqual([
      ['--version', null, '1'],
      ['rrd verify', r.sha256, '1'], ['rrd stats', r.sha256, '1'], ['rrd print -vv', r.sha256, '1'], ['rrd print -vvv', r.sha256, '1'],
    ]);
    // the bounds as said
    expect([RRD_CLI_TIMEOUT_MS, RRD_CLI_OUTPUT_MAX, RRD_PRINT_DATA_MAX]).toEqual([10_000, 4 * 1024 * 1024, 16 * 1024 * 1024]);

    // TIMMY_RERUN names the program first
    const named = await readRrdWithCli(PROBE, { env: { PATH: '/usr/bin:/bin', TIMMY_RERUN: join(bin, 'rerun') } });
    expect(named.cli.via).toBe('set by TIMMY_RERUN');
    expect(named.timelines).toEqual(r.timelines);
  });

  it('the edge sample: a frame past 2^53 kept exact, a negative duration, a timestamp with no fraction, a text holding the table\'s bars', async () => {
    const r = await readRrdWithCli(EDGE, { env: envOf(fakeBin()) });
    expect(r.entities).toMatchObject({ state: 'read', count: 4, paths: ['/__properties', '/a/b', '/space\\ name/é', '/text'], static: { state: 'read', paths: ['/__properties'] } });
    if (r.timelines.state !== 'read') throw new Error(r.timelines.why);
    expect(r.timelines.list.map((t) => [t.name, t.kind.state === 'read' ? t.kind.kind : t.kind.why, t.range.state === 'read' ? t.range.words : t.range.why])).toEqual([
      ['frame', 'sequence', '-5 to 9007199254740993'],
      ['log_time', 'timestamp', '2026-10-20T13:10:10.483927785 to 2026-10-20T13:10:10.487049994 (3.122209 ms)'],
      ['t', 'duration', '-1.25 s to 3725.000000001 s'],
      ['wall', 'timestamp', '1970-01-01T00:00:00 to 2026-10-20T12:53:45.500 (1792500825.5 s)'],
    ]);
  });

  it('no rerun here: everything unknown, with why and its setup; nothing is run', async () => {
    const r = await readRrdWithCli(PROBE, { env: { PATH: '' } });
    expect(r).toMatchObject({ state: 'not read', cli: { version: null, line: null, via: null }, setup: RERUN_SETUP, calls: [] });
    expect(r.words).toBe('not read by the Rerun CLI: rerun is not on the PATH and TIMMY_RERUN is not set');
    for (const u of [r.verify, ...unknownAll(r)]) expect(u).toEqual({ state: 'unknown', reason: 'not-installed', why: 'rerun is not on the PATH and TIMMY_RERUN is not set' });
  });

  it('a version not checked here says which was checked, and nothing more is run; a version line that says none does not parse', async () => {
    const bin = fakeBin();
    const r = await readRrdWithCli(PROBE, { env: envOf(bin, { FAKE_RERUN_MODE: 'version=0.37.1' }) });
    expect(r.state).toBe('not read');
    expect(r.cli).toMatchObject({ version: '0.37.1', via: 'rerun on the PATH' });
    const why = 'rerun-cli 0.37.1 is installed here, and Timmy reads only the output of rerun-cli 0.38.1 (the version its reading was checked against), so it ran nothing more';
    for (const u of [r.verify, ...unknownAll(r)]) expect(u).toEqual({ state: 'unknown', reason: 'version-not-checked', why });
    expect(r.calls.map((c) => c.command)).toEqual(['rerun --version']);
    const odd = await readRrdWithCli(PROBE, { env: envOf(bin, { FAKE_RERUN_MODE: 'version=banana' }) });
    expect(odd.cli.version).toBeNull();
    expect(odd.entities).toEqual({ state: 'unknown', reason: 'does-not-parse', why: 'its version line says no version Timmy reads ("rerun-cli banana (FAKE: tests/fixtures/fake-rerun.mjs, a TEST DOUBLE; not Rerun)"), so it ran nothing more' });
  });

  it('a timeout stops the call and its whole process group; what it would have read stays unknown', async () => {
    const bin = fakeBin();
    const pids = join(box(), 'pids');
    const r = await readRrdWithCli(PROBE, { env: envOf(bin, { FAKE_RERUN_MODE: 'sleep:stats', FAKE_RERUN_PIDS: pids }), timeoutMs: 600 });
    const stats = r.calls.find((c) => c.command === 'rerun rrd stats')!;
    expect(stats).toMatchObject({ exit: null, signal: 'SIGKILL', timedOut: true, cut: false });
    expect(stats.ms).toBeGreaterThanOrEqual(550);
    expect(stats.ms).toBeLessThan(5000);
    expect(r.verify.state).toBe('passed');
    for (const u of unknownAll(r)) expect(u).toEqual({ state: 'unknown', reason: 'timeout', why: 'rrd stats gave no answer in 0.6 s, so it was stopped (its process group was killed)' });
    expect(r.calls.map((c) => c.command)).toEqual(['rerun --version', 'rerun rrd verify', 'rerun rrd stats']);
    // the FAKE's own child (sleep 30) was in that process group: it is gone too
    const child = Number(readFileSync(pids, 'utf8').trim());
    expect(child).toBeGreaterThan(0);
    await until(() => !alive(child));
    expect(alive(child)).toBe(false);

    // a verify that does not answer: nothing else is run
    const v = await readRrdWithCli(PROBE, { env: envOf(bin, { FAKE_RERUN_MODE: 'sleep:verify', FAKE_RERUN_PIDS: pids }), timeoutMs: 400 });
    expect(v.verify).toEqual({ state: 'unknown', reason: 'timeout', why: 'rrd verify gave no answer in 0.4 s, so it was stopped (its process group was killed)' });
    for (const u of unknownAll(v)) expect(u).toEqual({ state: 'unknown', reason: 'timeout', why: 'not read: rrd verify gave no answer in 0.4 s, so nothing more was run' });
    expect(v.calls.map((c) => c.command)).toEqual(['rerun --version', 'rerun rrd verify']);
  });

  it('a call still running when Timmy\'s process exits is not left behind: its process group is killed with it', async () => {
    const bin = fakeBin();
    const dir = box();
    const pids = join(dir, 'pids');
    const script = join(dir, 'exits-early.mts');
    // a process that starts a reading which hangs (the FAKE's verify sleeps, the timeout is 30 s) and exits once it hangs
    writeFileSync(script, [
      `import { existsSync, readFileSync } from 'node:fs';`,
      `import { readRrdWithCli } from ${JSON.stringify(resolve('src/vox/rrd-cli.ts'))};`,
      `void readRrdWithCli(readFileSync(${JSON.stringify(join(FIX, 'probe.rrd'))}), { env: { PATH: ${JSON.stringify(`${bin}:/usr/bin:/bin`)}, FAKE_RERUN_MODE: 'sleep:verify', FAKE_RERUN_PIDS: ${JSON.stringify(pids)} }, timeoutMs: 30_000 });`,
      `const t = setInterval(() => { if (existsSync(${JSON.stringify(pids)}) && readFileSync(${JSON.stringify(pids)}, 'utf8').trim()) { clearInterval(t); process.exit(0); } }, 20);`,
    ].join('\n'));
    const loader = createRequire(import.meta.url).resolve('tsx');
    const code = await new Promise<number | null>((done) => { const c = spawn(process.execPath, ['--import', loader, script], { stdio: 'ignore' }); c.once('close', (n) => done(n)); });
    expect(code).toBe(0);
    const child = Number(readFileSync(pids, 'utf8').trim());
    expect(child).toBeGreaterThan(0);
    await until(() => !alive(child));
    expect(alive(child)).toBe(false);
  }, 30_000);

  it('an output over the cap: the read stops there and says so; a range not read stays unknown', async () => {
    const bin = fakeBin();
    const r = await readRrdWithCli(PROBE, { env: envOf(bin, { FAKE_RERUN_MODE: 'huge:stats' }) });
    const stats = r.calls.find((c) => c.command === 'rerun rrd stats')!;
    expect(stats).toMatchObject({ cut: true, bytes: RRD_CLI_OUTPUT_MAX, timedOut: false });
    for (const u of unknownAll(r)) expect(u).toEqual({ state: 'unknown', reason: 'over-cap', why: 'rrd stats printed more than 4 MiB, the most read here, so the read stopped there' });

    // the data's print over a smaller cap: the entities and the kinds are read, each range is not
    const d = await readRrdWithCli(PROBE, { env: envOf(bin, { FAKE_RERUN_MODE: 'huge:print-vvv' }), max: 1024 * 1024 });
    expect(d.entities).toMatchObject({ state: 'read', count: 4 });
    if (d.timelines.state !== 'read') throw new Error(d.timelines.why);
    for (const t of d.timelines.list) {
      expect(t.kind.state, t.name).toBe('read');
      expect(t.range, t.name).toEqual({ state: 'unknown', reason: 'over-cap', why: 'rrd print -vvv printed more than 1 MiB, the most read here, so the read stopped there' });
    }
    expect(d.calls.find((c) => c.command === 'rerun rrd print -vvv')).toMatchObject({ cut: true, bytes: 1024 * 1024 });
  });

  it('a bad exit and output that does not parse are said, never guessed past', async () => {
    const bin = fakeBin();
    const bad = await readRrdWithCli(PROBE, { env: envOf(bin, { FAKE_RERUN_MODE: 'bad-exit:stats' }) });
    for (const u of unknownAll(bad)) expect(u).toEqual({ state: 'unknown', reason: 'failed', why: 'rrd stats ended with exit 2: FAKE rerun: failed on purpose' });
    const garbage = await readRrdWithCli(PROBE, { env: envOf(bin, { FAKE_RERUN_MODE: 'garbage:stats' }) });
    for (const u of unknownAll(garbage)) expect(u).toEqual({ state: 'unknown', reason: 'does-not-parse', why: 'rrd stats\' output does not parse as rerun-cli 0.38.1\'s: it has no "Num chunks per entity" section' });
    // the headers' print garbled: the entities and the timelines' names are read (rrd stats), their kinds, ranges and the
    // static entities are not
    const headers = await readRrdWithCli(PROBE, { env: envOf(bin, { FAKE_RERUN_MODE: 'garbage:print-vv' }) });
    expect(headers.entities).toMatchObject({ state: 'read', count: 4, static: { state: 'unknown', reason: 'does-not-parse' } });
    if (headers.timelines.state !== 'read') throw new Error(headers.timelines.why);
    const why = 'rrd print -vv\'s output does not parse as rerun-cli 0.38.1\'s: it printed 0 chunks, and rrd stats counted 4';
    expect(headers.timelines.list.map((t) => [t.name, t.kind, t.range])).toEqual(['frame', 'log_time', 't'].map((n) => [n, { state: 'unknown', reason: 'does-not-parse', why }, { state: 'unknown', reason: 'does-not-parse', why }]));
    expect(headers.calls.map((c) => c.command)).not.toContain('rerun rrd print -vvv');
  });

  it('Rerun\'s own check failed: its words are kept, and nothing more is read', async () => {
    const r = await readRrdWithCli(CUT, { env: envOf(fakeBin()) });
    expect(r.state).toBe('read');
    expect(r.words).toBe('rerun-cli 0.38.1 could not verify it (rrd verify failed), so nothing more was read');
    expect(r.verify).toEqual({ state: 'failed', why: 'rrd verify ended with exit 1: stdin: Missing RRD footer / no RRD manifests · Error: Verification failed with 1 errors (the recording was given on its standard input)', by: 'rrd verify' });
    for (const u of unknownAll(r)) expect(u).toEqual({ state: 'unknown', reason: 'verify-failed', why: 'not read: Rerun\'s own check of the file failed (rrd verify), so its stats and print were not run' });
    expect(r.calls.map((c) => [c.command, c.exit])).toEqual([['rerun --version', 0], ['rerun rrd verify', 1]]);
  });

  it('the data\'s print runs only on a small enough recording; above that, each range says why it is unknown', async () => {
    const r = await readRrdWithCli(PROBE, { env: envOf(fakeBin()), dataMax: 1024 });
    expect(r.calls.map((c) => c.command)).not.toContain('rerun rrd print -vvv');
    if (r.timelines.state !== 'read') throw new Error(r.timelines.why);
    for (const t of r.timelines.list) {
      expect(t.kind.state).toBe('read');
      expect(t.range).toEqual({ state: 'unknown', reason: 'not-run', why: 'not read: rrd print -vvv prints the data itself, and is run here only on a recording of at most 1.0 KB (this one is 11.5 KB)' });
    }
  });
});

describe('kept by the file\'s sha256 and the CLI\'s version, read in the background (R9 H159)', () => {
  afterEach(async () => { await rrdReadingsIdle(); forgetRrdReadings(); });
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

  it('says "being read" until the background read is done; an unchanged file is not read again; other bytes or another version are', async () => {
    forgetRrdReadings();
    const bin = fakeBin();
    const log = join(box(), 'calls.jsonl');
    const env = envOf(bin, { FAKE_RERUN_CALLS: log });
    const root = box();
    const logged: string[] = [];
    const job = (rel: string, body: Buffer) => ({ root, rel, sha256: sha(body), env, read: () => body, log: (c: RrdCall) => logged.push(`${rel} ${c.command}`) });

    // asked on a draw path: nothing runs, and it says it is not read yet
    const before = rrdReadingNow({ sha256: sha(PROBE), bytes: PROBE.length, env });
    expect(before).toMatchObject({ state: 'not read', words: 'not read yet: rerun-cli reads it in the background, once tab 6 is served' });
    expect(before.entities).toEqual({ state: 'unknown', reason: 'not-run', why: 'not read yet: rerun-cli reads it in the background, once tab 6 is served' });
    expect(callsOf(log)).toEqual([]);

    startRrdReading(job('rec/probe.rrd', PROBE));
    const being = rrdReadingNow({ sha256: sha(PROBE), bytes: PROBE.length, env });
    expect(being).toMatchObject({ state: 'being read', words: 'being read by the Rerun CLI, in the background' });
    for (const u of [being.verify, being.entities, being.timelines]) expect(u).toEqual({ state: 'unknown', reason: 'being-read', why: 'being read by the Rerun CLI, in the background' });
    await rrdReadingsIdle();
    const read = rrdReadingNow({ sha256: sha(PROBE), bytes: PROBE.length, env });
    const direct = await readRrdWithCli(PROBE, { env: envOf(fakeBin()) });
    expect(read.state).toBe('read');
    expect([read.entities, read.timelines, read.verify, read.cli]).toEqual([direct.entities, direct.timelines, direct.verify, direct.cli]);
    expect(callsOf(log).map((c) => c.argv.join(' '))).toEqual(['--version', 'rrd verify', 'rrd stats', 'rrd print -vv', 'rrd print -vvv']);
    expect(logged).toEqual(['rec/probe.rrd rerun --version', 'rec/probe.rrd rerun rrd verify', 'rec/probe.rrd rerun rrd stats', 'rec/probe.rrd rerun rrd print -vv', 'rec/probe.rrd rerun rrd print -vvv']);

    // unchanged: not read again, under any name
    startRrdReading(job('rec/probe.rrd', PROBE));
    startRrdReading(job('copy/same.rrd', PROBE));
    await rrdReadingsIdle();
    expect(callsOf(log)).toHaveLength(5);
    expect(rrdReadingNow({ sha256: sha(PROBE), bytes: PROBE.length, env })).toEqual(read);

    // other bytes: read, and the program's version is not asked again
    startRrdReading(job('rec/edge.rrd', EDGE));
    await rrdReadingsIdle();
    expect(callsOf(log).slice(5).map((c) => c.argv.join(' '))).toEqual(['rrd verify', 'rrd stats', 'rrd print -vv', 'rrd print -vvv']);
    expect(rrdReadingNow({ sha256: sha(EDGE), bytes: EDGE.length, env }).entities).toMatchObject({ state: 'read', count: 4 });

    // bytes changed since they were listed: the job reads nothing (the next list asks for the new bytes)
    startRrdReading({ ...job('rec/moved.rrd', CUT), sha256: 'f'.repeat(64) });
    await rrdReadingsIdle();
    expect(callsOf(log)).toHaveLength(9);
    expect(rrdReadingNow({ sha256: 'f'.repeat(64), bytes: CUT.length, env }).state).toBe('not read');

    // another program, of a version not checked here: asked once, then said at once, with nothing more run
    const other = envOf(fakeBin(), { FAKE_RERUN_CALLS: log, FAKE_RERUN_MODE: 'version=0.37.1' });
    startRrdReading({ ...job('rec/probe.rrd', PROBE), env: other });
    await rrdReadingsIdle();
    const unchecked = rrdReadingNow({ sha256: sha(PROBE), bytes: PROBE.length, env: other });
    expect(unchecked.entities).toMatchObject({ state: 'unknown', reason: 'version-not-checked' });
    expect(rrdReadingNow({ sha256: sha(EDGE), bytes: EDGE.length, env: other }).entities).toMatchObject({ state: 'unknown', reason: 'version-not-checked' });
    expect(callsOf(log).slice(9).map((c) => c.argv.join(' '))).toEqual(['--version']);

    // no rerun at all: said at once, nothing started
    expect(rrdReadingNow({ sha256: sha(PROBE), bytes: PROBE.length, env: { PATH: '' } }).entities).toMatchObject({ state: 'unknown', reason: 'not-installed' });
  });
});

describe('each call in the project\'s log (R9 H159)', () => {
  afterEach(async () => { await rrdReadingsIdle(); forgetRrdReadings(); });
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  const busOf = (): Array<{ kind: string; payload: Record<string, unknown> }> => {
    const file = join(process.env.TIMMY_STORE!, 'runs.jsonl');
    return (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []).map((l) => JSON.parse(l)).filter((e) => e.kind === 'rrd.cli');
  };

  it('logs the command, the CLI\'s version, the exit, the duration, the bytes and whether it was cut; the Logs tab lists each', async () => {
    forgetRrdReadings();
    const root = box();
    startRrdReading({ root, rel: 'rec/probe.rrd', sha256: sha(PROBE), env: envOf(fakeBin()), read: () => PROBE });
    await rrdReadingsIdle();
    const bus = busOf();
    expect(bus.map((e) => [e.payload.command, e.payload.version, e.payload.exit, e.payload.cut, e.payload.timed_out, e.payload.status, e.payload.path, e.payload.sha256, e.payload.project_id])).toEqual([
      ['rerun --version', null, 0, false, false, 'ok', 'rec/probe.rrd', sha(PROBE), projectId(root)],
      ...['rerun rrd verify', 'rerun rrd stats', 'rerun rrd print -vv', 'rerun rrd print -vvv'].map((c) => [c, '0.38.1', 0, false, false, 'ok', 'rec/probe.rrd', sha(PROBE), projectId(root)]),
    ]);
    expect(bus.map((e) => e.payload.bytes)).toEqual([bytesOf('version.stdout'), bytesOf('verify.stderr'), bytesOf('stats.stdout') + bytesOf('stats.stderr'), bytesOf('print-vv.stdout'), bytesOf('print-vvv.stdout')]);
    for (const e of bus) expect(e.payload.ms).toBeGreaterThanOrEqual(0);
    expect(bus[0].payload.words).toMatch(/^rerun --version · rec\/probe\.rrd · exit 0 · \d+ ms · 316 B read · not cut$/);
    expect(bus[2].payload.words).toMatch(/^rerun-cli 0\.38\.1 · rerun rrd stats · rec\/probe\.rrd · exit 0 · \d+ ms · 3\.0 KB read · not cut$/);
    // no folder of this computer in the log
    expect(JSON.stringify(bus)).not.toContain(root);
    // the Logs tab (tab 0) lists each call, newest first, with its words and how it ended
    const logs = readLogs({ home: box(), root, env: { TIMMY_STORE: process.env.TIMMY_STORE } });
    const rows = logs.events.filter((e) => e.tag === 'rrd.cli');
    expect(rows.map((r) => [r.source, r.status.word])).toEqual(Array(5).fill(['bus', 'ok']));
    expect(rows.map((r) => r.summary.replace(/ · \d+ ms · /, ' · N ms · '))).toEqual([
      'rerun-cli 0.38.1 · rerun rrd print -vvv · rec/probe.rrd · exit 0 · N ms · 18.2 KB read · not cut',
      'rerun-cli 0.38.1 · rerun rrd print -vv · rec/probe.rrd · exit 0 · N ms · 15.7 KB read · not cut',
      'rerun-cli 0.38.1 · rerun rrd stats · rec/probe.rrd · exit 0 · N ms · 3.0 KB read · not cut',
      'rerun-cli 0.38.1 · rerun rrd verify · rec/probe.rrd · exit 0 · N ms · 31 B read · not cut',
      'rerun --version · rec/probe.rrd · exit 0 · N ms · 316 B read · not cut',
    ]);
  });

  it('a call cut at the cap and one that timed out say so in the log', async () => {
    forgetRrdReadings();
    const root = box();
    startRrdReading({ root, rel: 'a.rrd', sha256: sha(PROBE), env: envOf(fakeBin(), { FAKE_RERUN_MODE: 'huge:stats' }), read: () => PROBE });
    await rrdReadingsIdle();
    const cut = busOf().find((e) => e.payload.command === 'rerun rrd stats')!;
    expect(cut.payload).toMatchObject({ cut: true, status: 'cut', bytes: RRD_CLI_OUTPUT_MAX });
    expect(cut.payload.words).toMatch(/ · 4\.0 MB read · cut there \(over the cap\)$/);
    forgetRrdReadings();
    startRrdReading({ root, rel: 'b.rrd', sha256: sha(EDGE), env: envOf(fakeBin(), { FAKE_RERUN_MODE: 'sleep:verify' }), read: () => EDGE, timeoutMs: 400 });
    await rrdReadingsIdle();
    const slow = busOf().find((e) => e.payload.path === 'b.rrd' && e.payload.command === 'rerun rrd verify')!;
    expect(slow.payload).toMatchObject({ timed_out: true, status: 'timed out', exit: null, signal: 'SIGKILL' });
    expect(slow.payload.words).toMatch(/^rerun-cli 0\.38\.1 · rerun rrd verify · b\.rrd · no exit: stopped after \d+ ms \(no answer in time; its process group was killed\) · 0 B read · not cut$/);
  }, 30_000);
});

// One test runs the real CLI, when it is installed here and is the version checked; otherwise it is skipped, and says why.
const REAL = ((): { ok: true } | { ok: false; why: string } => {
  try {
    const line = execFileSync('rerun', ['--version'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0];
    const v = /^rerun-cli (\d+\.\d+\.\d+)/.exec(line)?.[1];
    return v && RRD_CLI_CHECKED.includes(v) ? { ok: true } : { ok: false, why: `the rerun here says "${line.slice(0, 40)}", not a checked version` };
  } catch { return { ok: false, why: 'rerun is not installed here' }; }
})();
describe('the real Rerun CLI, when it is installed (R9 H159)', () => {
  it.skipIf(!REAL.ok)(`reads the sample as its captured outputs say${REAL.ok ? '' : ` (skipped: ${REAL.why})`}`, async () => {
    const real = await readRrdWithCli(PROBE, { env: process.env });
    expect(real.cli.version).toBe('0.38.1');
    expect(real.verify.state).toBe('passed');
    expect(real.entities).toEqual({
      state: 'read', count: 4, paths: PROBE_ENTITIES, by: 'rrd stats',
      stores: [{ kind: 'recording', application: 'timmy-r9-probe', recording: 'probe-1', entities: 4 }],
      static: { state: 'read', paths: ['/__properties', '/notes'], by: 'rrd print -vv' },
    });
    expect(real.timelines).toEqual({ state: 'read', by: 'rrd stats', list: PROBE_TIMELINES });
    const cut = await readRrdWithCli(CUT, { env: process.env });
    expect(cut.verify).toMatchObject({ state: 'failed' });
  });
});
