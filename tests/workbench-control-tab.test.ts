/**
 * R5 (H137): tab 7, Control Room (src/workbench/control-tab.ts): its reading over REAL records in temporary folders, and its
 * view at the three sizes the R5 order names (160x45, 120x40, 100x30).
 *
 * REAL here: the job store's jobs (sh and sleep, in this test's own job store) and their logs; a receipt sealed in this test's
 * own store by the job store's seal, then verified (and a copy of the chain with one field changed, which does not verify);
 * a chat turn's hold taken by this process; Timmy Connect's device records and a remote job record, written in this file's
 * own Timmy home through Connect's own store; a dispatch record in the project's folder.
 * FAKE here: the lane programs on PATH (a FAKE stand-in written as the review package writes its own, and a plain script that
 * is not one; neither is ever run: their log of runs stays empty), the devices (documentation addresses 192.0.2.x, which no
 * computer has; none is contacted), the remote job, the dispatch record, and one operation's run detail (a FIXTURE value).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { takeTurnHold } from '../src/agent/chat-turn.js';
import { connectPaths, updateDevices } from '../src/connect/store.js';
import type { DeviceRecord } from '../src/connect/types.js';
import type { RunDetail } from '../src/contracts/run-detail.js';
import type { WorkspaceFrame } from '../src/contracts/workspace.js';
import { JobManager } from '../src/jobs/index.js';
import { projectId } from '../src/project/index.js';
import type { Decision } from '../src/room/decisions.js';
import { appendReceipt, readChain, type Receipt } from '../src/utils/receipts.js';
import {
  agentOf, checkReceipt, CONTROL_LIST, controlRoomView, LANE_ORDER, liveTurnDetail, paneJobs, PREVIEWS_WORDS, readControl, sideBySideAt,
  type ControlCtx, type ControlData, type LiveTurnRow,
} from '../src/workbench/control-tab.js';
import { glyphsFor, innerWidth } from '../src/workbench/frame.js';
import { layoutFor } from '../src/workbench/layout.js';
import type { Data, TurnRow } from '../src/workbench/model.js';
import { readJobs, type JobRow } from '../src/workbench/state.js';
import { lineCells, plain, type Line, type Role } from '../src/workbench/text.js';

const g = glyphsFor(true);
const SIZES = [[160, 45], [120, 40], [100, 30]] as const;
const boxes: string[] = [];
const managers: JobManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.stopAll(); });
afterAll(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(25);
  }
}

function box(): string {
  const b = realpathSync(mkdtempSync(join(tmpdir(), 'wb-control-')));
  boxes.push(b);
  return b;
}

/** A project folder of its own, and a job store of its own beside it. */
function project(): { root: string; jobsDir: string; box: string } {
  const b = box();
  const root = join(b, 'tray');
  mkdirSync(root);
  return { root, jobsDir: join(b, 'jobs'), box: b };
}

/** A folder for PATH with one FAKE stand-in (written as scripts/review/fake-lanes writes its own) and one plain script. */
function lanesBin(b: string): { bin: string; log: string } {
  const bin = join(b, 'bin');
  mkdirSync(bin);
  const log = join(b, 'fake-lanes.log');
  writeFileSync(join(bin, 'opencode'), [
    '#!/bin/sh',
    '# FAKE lane stand-in (Timmy review package): a real opencode is never started from the review. It notes the call and waits.',
    'printf \'%s FAKE LANE opencode %s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${FAKE_LANES_LOG:-/dev/null}"',
    'sleep 600', '',
  ].join('\n'));
  // FAKE (test): a plain script named hermes, with no stand-in words: it is found, and nothing here can tell it from a real one
  writeFileSync(join(bin, 'hermes'), `#!/bin/sh\necho "hermes ran" >> '${log}'\n`);
  chmodSync(join(bin, 'opencode'), 0o755);
  chmodSync(join(bin, 'hermes'), 0o755);
  return { bin, log };
}

const ISO = (ms: number): string => new Date(ms).toISOString();

/** A FAKE device record (a documentation address: no computer has it). */
function device(id: string, probe: DeviceRecord['probe'], hostKey = true): DeviceRecord {
  return {
    id, name: id, address: '192.0.2.10', port: 22, user: 'fake', identity: 'agent', ssh_config: 'timmy', os: 'linux', shell: 'posix',
    host_key: hostKey ? { type: 'ssh-ed25519', fingerprint: 'SHA256:FAKEFAKEFAKE', confirmed_at: ISO(Date.now() - 86_400_000), confirmed_by: 'cli' } : null,
    host_key_scan: null, host_key_refused: null, remote_dir: '.timmy-remote', added_at: ISO(Date.now() - 86_400_000), probe,
  };
}

const text = (lines: readonly Line[]): string => lines.map(plain).join('\n');
const segsWith = (lines: readonly Line[], re: RegExp): Array<{ text: string; role: Role }> => lines.flat().filter((s) => re.test(s.text)).map((s) => ({ text: s.text, role: s.role ?? 'text' }));

// ── the reading ────────────────────────────────────────────────────────────────

describe('tab 7, Control Room: the reading (readControl reads files only)', () => {
  it('the six lanes in their sessions\' order: a FAKE stand-in says FAKE, a plain program is found, a missing one is not installed; none is run, and none runs unless a record shows it (a live job of /agent, a dispatch record)', async () => {
    const p = project();
    const { bin, log } = lanesBin(p.box);
    const env = { ...process.env, PATH: bin, FAKE_LANES_LOG: log };
    expect(LANE_ORDER).toEqual(['opencode', 'hermes', 'pi', 'openhands', 'jcode', 'minds']);
    const d0 = readControl({ root: p.root, env, records: [], jobs: [], connect: () => ({ schema: 'timmy.connect/1', as_of: ISO(Date.now()), devices: [], jobs: [], unreadable: [] }) });
    expect(d0.lanes.map((l) => [l.id, l.program, l.running])).toEqual([
      ['opencode', 'fake', undefined], ['hermes', 'found', undefined], ['pi', 'none', undefined],
      ['openhands', 'none', undefined], ['jcode', 'none', undefined], ['minds', 'none', undefined],
    ]);
    expect(d0.lanes[0].path).toBe(join(bin, 'opencode'));
    expect(d0.lanes[2].install).toBe('npm i -g @earendil-works/pi-coding-agent');
    // nothing was run: neither program wrote its line
    expect(existsSync(log)).toBe(false);

    // records that show a lane running: a live job of /agent openhands (REAL: this test's job store), a dispatch record of hermes
    const jobs = new JobManager({ dir: p.jobsDir });
    managers.push(jobs);
    const agent = jobs.start({ kind: 'task', label: 'agent openhands a0e137aa1: FAKE task (test)', project: 'tray', root: p.root, command: 'sleep', args: ['30'] });
    await until('the FAKE agent job running', () => jobs.get(agent.id)?.state === 'running');
    mkdirSync(join(p.root, '.timmy', 'dispatch'), { recursive: true });
    writeFileSync(join(p.root, '.timmy', 'dispatch', 'dp_fake1.json'), JSON.stringify({ id: 'dp_fake1', lifecycle: 'running', dispatched_at: ISO(Date.now() - 60_000), plan: { harnesses: ['hermes'] } }));
    writeFileSync(join(p.root, '.timmy', 'dispatch', 'dp_fake2.json'), JSON.stringify({ id: 'dp_fake2', lifecycle: 'archived', plan: { harnesses: ['jcode'] } }));
    writeFileSync(join(p.root, '.timmy', 'dispatch', 'broken.json'), '{ not json');
    const rows = readJobs(jobs.list(), p.root, { mine: new Set(), chain: [] });
    const d1 = readControl({ root: p.root, env, records: jobs.list(), jobs: rows, connect: () => ({ schema: 'timmy.connect/1', as_of: ISO(Date.now()), devices: [], jobs: [], unreadable: [] }) });
    const byId = Object.fromEntries(d1.lanes.map((l) => [l.id, l]));
    expect(byId.openhands.running).toMatchObject({ by: 'job', id: agent.id });
    expect(byId.hermes.running).toMatchObject({ by: 'dispatch', id: 'dp_fake1' });
    expect(byId.jcode.running).toBeUndefined();
    expect(byId.opencode.running).toBeUndefined();
    expect(agentOf('agent openhands a0e137aa1: FAKE task (test)')).toBe('openhands');
    expect(agentOf('agent openhands a0e137aa: seven hex digits')).toBeNull();
    expect(agentOf('SLOW.md › wait')).toBeNull();
    expect(existsSync(log)).toBe(false);
  });

  it('Timmy Connect\'s devices from its own records, each with its last probe\'s word: live only for an answer within 30 minutes; its remote jobs counted as their status files said; an unreadable record is said so', async () => {
    const p = project();
    const home = process.env.TIMMY_HOME!;
    const now = Date.now();
    const cp = connectPaths(home);
    updateDevices(cp, (devices) => {
      devices.splice(0, devices.length,
        device('fake-live', { at: ISO(now - 5 * 60_000), outcome: 'connected', words: 'connected: FAKE probe (test)' }),
        device('fake-old', { at: ISO(now - 3 * 3_600_000), outcome: 'connected', words: 'connected: FAKE probe (test), long ago' }),
        device('fake-gone', { at: ISO(now - 60_000), outcome: 'unreachable', why: 'timed out', words: 'unreachable: timed out (FAKE)' }),
        device('fake-new', null, false));
    });
    mkdirSync(cp.jobs, { recursive: true });
    writeFileSync(join(cp.jobs, 'r0e137a01.json'), JSON.stringify({
      id: 'r0e137a01', kind: 'remote', label: 'FAKE remote job (test)', device: 'fake-live', remote_dir: '.timmy-remote/r0e137a01',
      script: { sha256: 'f'.repeat(64), bytes: 1, from: 'command', shell: 'posix' }, state: 'running', submitted_at: ISO(now - 120_000),
      remote: { read_at: ISO(now - 60_000), where: 'running', state: 'running' }, events: [],
    }));
    const d = readControl({ root: p.root, home, env: process.env, records: [], jobs: [], now });
    expect(d.devices.map((x) => [x.id, x.state, x.running, x.jobs])).toEqual([
      ['fake-live', 'live', 1, 1], ['fake-old', 'reached', 0, 0], ['fake-gone', 'unreachable', 0, 0], ['fake-new', 'not probed', 0, 0],
    ]);
    expect(d.devices[3].words).toBe('not probed yet: timmy connect probe fake-new');
    expect(d.devices[3].needs[0]).toMatch(/no host key fetched yet: timmy connect scan fake-new/);
    expect(d.notes).toEqual([]);
    // a devices file that is not Connect's: none is listed, and the note says why
    writeFileSync(cp.devices, '{ not json');
    const bad = readControl({ root: p.root, home, env: process.env, records: [], jobs: [], now });
    expect(bad.devices).toEqual([]);
    expect(bad.notes.join('\n')).toMatch(/Timmy Connect: connect\/devices\.json could not be read \(.+ is not valid JSON\); its state is unknown/);
  });

  it('a chat turn being answered is read from its hold (this process\'s, taken as a turn takes it), without removing one; none once it is given back', () => {
    const p = project();
    const none = { schema: 'timmy.connect/1' as const, as_of: ISO(Date.now()), devices: [], jobs: [], unreadable: [] };
    const held = takeTurnHold(p.root, 'repl');
    if (!held.ok) throw new Error(held.lines.join(' '));
    try {
      const d = readControl({ root: p.root, env: process.env, records: [], jobs: [], connect: () => none });
      expect(d.turns).toHaveLength(1);
      expect(d.turns[0]).toMatchObject({ surface: 'repl', pid: process.pid, mine: true, proof: 'alive' });
    } finally { held.hold.release(); }
    expect(readControl({ root: p.root, env: process.env, records: [], jobs: [], connect: () => none }).turns).toEqual([]);
  });

  it('each pane\'s log, its last lines (escapes out); with nothing running, the newest ended runs are the panes, and their receipts are verified against the chain as read: a changed chain does not verify, an id not on it is not found', async () => {
    const p = project();
    const none = { schema: 'timmy.connect/1' as const, as_of: ISO(Date.now()), devices: [], jobs: [], unreadable: [] };
    // REAL: the job store seals each ended job in this test's own store, as the REPL's does (its short id on the record)
    const jobs = new JobManager({
      dir: p.jobsDir,
      seal: (j) => appendReceipt('runs', { kind: 'run', subject: `task · ${j.label} · ${j.state}`, policy: 'human-gated', status: j.state === 'completed' ? 'ok' : 'failed', project: 'tray', project_id: projectId(p.root), job: { id: j.id, kind: j.kind, label: j.label, state: j.state, exit_code: j.exitCode ?? null }, spans: [], artifacts: [] }).hash.slice(7, 15),
    });
    managers.push(jobs);
    const done = jobs.start({ kind: 'task', label: 'FAKE job (test): three lines', project: 'tray', root: p.root, command: 'sh', args: ['-c', 'printf "one\\n\\033[1mtwo\\033[0m\\nthree\\n"'] });
    await jobs.done(done.id);
    const live = jobs.start({ kind: 'task', label: 'FAKE job (test): eight lines, then waits', project: 'tray', root: p.root, command: 'sh', args: ['-c', 'for i in 1 2 3 4 5 6 7 8; do echo "line $i"; done; sleep 30'] });
    await until('its eight lines in its log', () => (jobs.get(live.id)?.lines ?? 0) >= 8);
    const chain = (): Receipt[] => readChain('runs');
    let rows = readJobs(jobs.list(), p.root, { mine: new Set(), chain: chain() });
    expect(paneJobs(rows, [], 0)).toMatchObject({ live: [{ id: live.id }], quiet: [] });
    const running = readControl({ root: p.root, env: process.env, records: jobs.list(), jobs: rows, chain: chain(), connect: () => none });
    expect(running.tails[live.id]).toEqual({ lines: ['line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8'] });
    expect(running.tails[done.id]).toBeUndefined();
    // a chat turn being answered is running too: no quiet panes then
    expect(paneJobs(rows.filter((j) => !j.live), [], 1).quiet).toEqual([]);

    await jobs.stop(live.id);
    rows = readJobs(jobs.list(), p.root, { mine: new Set(), chain: chain() });
    const quiet = paneJobs(rows, [], 0).quiet;
    expect(quiet.map((j) => j.id)).toEqual([live.id, done.id]);
    const ended = readControl({ root: p.root, env: process.env, records: jobs.list(), jobs: rows, chain: chain(), connect: () => none });
    expect(ended.tails[done.id]).toEqual({ lines: ['one', 'two', 'three'] });
    const short = rows.find((j) => j.id === done.id)!.receipt!;
    expect(short).toMatch(/^[0-9a-f]{8}$/);
    expect(ended.receipts[done.id]).toEqual({ state: 'verified' });
    expect(ended.receipts[live.id]).toEqual({ state: 'verified' });
    // the same receipt in a chain whose body was changed: not verified, with why; an id that is not on it: not found
    const changed = chain().map((r) => (r.hash.slice(7, 15) === short ? { ...r, subject: `${r.subject} (changed)` } : r));
    expect(checkReceipt(changed, done.id, short).state).toBe('failed');
    expect(checkReceipt(chain(), done.id, '00000000')).toEqual({ state: 'not found', reason: 'not found on the chain read here' });
    expect(checkReceipt(chain(), 'j000000', short)).toMatchObject({ state: 'not found' });
  }, 30_000);
});

// ── the view ───────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-10-15T12:00:00Z');
const ROOT = '/FAKE/tray';

/** A job's row as the Workbench reads it (src/workbench/state.ts JobRow), FAKE values for the view. */
function row(o: Partial<JobRow> & { id: string; label: string }): JobRow {
  return {
    project: 'tray', root: ROOT, kind: 'workflow', state: 'running', mark: 'running', word: 'running', why: '',
    outcome: { state: 'running', words: 'running' }, live: true, stale: false, startedAt: ISO(NOW - 12_000), elapsedMs: 12_000, elapsed: '12 s',
    owner: 'workbench', ownerWords: 'started by this Workbench', steps: [], ...o,
  };
}
const ended = (o: Partial<JobRow> & { id: string; label: string }): JobRow => row({ state: 'completed', mark: 'ok', word: 'completed', live: false, endedAt: ISO(NOW - 300_000), elapsed: '3.1 s', exitCode: 0, outcome: { state: 'succeeded', words: 'succeeded' }, ...o });

function decision(key: string, title: string): Decision {
  return { key, kind: 'interrupted', blocks: false, title, needed: 'whether to run it again: upmd resumes nothing', why: 'FAKE (test)', commands: ['/run SLOW.md long'] };
}

const sealed = (receipt: string, o: Partial<TurnRow> = {}): TurnRow => ({ receipt, surface: 'repl', state: 'answered', model: 'fixture/chat-model', at: ISO(NOW - 30_000), ms: 2400, operation: null, ...o });

/** The workspace frame's connections, as `timmy workspace check` left them (FAKE observations), the rest of the frame unused here. */
const frame = (companion: 'live' | 'configured'): WorkspaceFrame => ({
  connections: [
    { id: 'companion', label: 'Browser companion', state: companion, words: companion === 'live' ? 'answered 1 min ago (running)' : 'not running when checked 5 s ago', observedAt: ISO(NOW - 60_000), setup: 'timmy watch' },
    { id: 'studio', label: 'Timmy Studio (tldraw)', state: 'configured', words: 'set up, not checked yet', observedAt: null, setup: 'timmy studio' },
  ],
} as unknown as WorkspaceFrame);

function data(o: { jobs?: JobRow[]; away?: JobRow[]; decisions?: Decision[]; turns?: TurnRow[]; details?: Data['details']; companion?: 'live' | 'configured' } = {}): ControlCtx['data'] {
  const items = o.decisions ?? [];
  return {
    project: { name: 'tray', root: ROOT, shown: '~/FAKE/tray', chosen: true, id: 'fakeid' },
    jobs: o.jobs ?? [], away: o.away ?? [], turns: o.turns ?? [], details: o.details ?? {},
    decisions: { items, more: 0, total: items.length, otherSetup: 0, tools: {}, operations: {}, notes: [] },
    frame: frame(o.companion ?? 'live'),
  };
}

function controlData(o: Partial<ControlData> = {}): ControlData {
  return {
    at: ISO(NOW),
    lanes: [
      { id: 'opencode', label: 'OpenCode CLI', program: 'fake', path: '/FAKE/bin/opencode' },
      { id: 'hermes', label: 'Hermes CLI', program: 'found', path: '/FAKE/bin/hermes', running: { by: 'dispatch', id: 'dp_fake1', since: ISO(NOW - 60_000) } },
      { id: 'pi', label: 'Pi Daemon', program: 'none', install: 'npm i -g @earendil-works/pi-coding-agent' },
      { id: 'openhands', label: 'OpenHands', program: 'none' },
      { id: 'jcode', label: 'jcode', program: 'none' },
      { id: 'minds', label: 'Minds CLI (Animoca Builder)', program: 'none' },
    ],
    devices: [
      { id: 'fake-live', name: 'fake-live', state: 'live', words: 'connected', at: ISO(NOW - 5 * 60_000), needs: [], running: 1, jobs: 1 },
      { id: 'fake-old', name: 'fake-old', state: 'reached', words: 'connected', at: ISO(NOW - 3 * 3_600_000), needs: [], running: 0, jobs: 0 },
      { id: 'fake-gone', name: 'fake-gone', state: 'unreachable', words: 'unreachable', at: ISO(NOW - 60_000), needs: [], running: 0, jobs: 0 },
    ],
    turns: [], tails: {}, receipts: {}, notes: [], ...o,
  };
}

function ctxAt(columns: number, rows: number, d: ControlCtx['data'], cursor = 0): ControlCtx {
  const l = layoutFor({ columns, rows, body: 'workspace' });
  return {
    ui: { cursor: { [CONTROL_LIST]: cursor }, companion: { serving: true, address: 'http://127.0.0.1:3001/', last: null }, studio: { serving: false, address: null, last: null } },
    data: d, g, width: innerWidth(l.center!.w), height: l.center!.h - 2, now: NOW, columns, can: { detail: true },
  };
}

/** The cells `from` to `to` of each row, the rows joined. */
function columnText(lines: readonly Line[], from: number, to: number): string {
  return lines.map((l) => [...plain(l)].slice(from, to).join('').trimEnd()).join('\n');
}

/** Side by side: each column's own text (the cells between the two rules, which are on every row); stacked: the one column. */
function cols(lines: readonly Line[]): string[] {
  const rows = lines.map((l) => [...plain(l)]);
  const rules = (rows[0] ?? []).flatMap((ch, x) => (ch === '│' && rows.every((r) => r[x] === '│') ? [x] : []));
  if (rules.length < 2) return [text(lines)];
  const [a, b] = rules;
  return [columnText(lines, 0, a - 1), columnText(lines, a + 2, b - 1), columnText(lines, b + 2, 1e9)];
}
/** A text's words on one line (a wrapped phrase read whole). */
const flat = (t: string): string => t.replace(/[┃│]/g, ' ').replace(/\s+/g, ' ');

const RUNNING = [
  row({ id: 'j0e1371', label: 'SLOW.md › wait', blocks: '0 of 1 step', operation: 'o0e13701' }),
  row({ id: 'j0e1372', label: 'FAKE job (test): sleep 300', kind: 'task', owner: 'ended-session', ownerWords: 'started by a Timmy session that has ended (pid 4242)', operation: 'o0e13702', recovery: { state: 'left running', words: 'left running: started by a Timmy session that has ended (pid 4242), and its process still runs.' } }),
];
const TAILS: ControlData['tails'] = { j0e1371: { lines: ['waiting for the release file', 'still waiting'] }, j0e1372: { why: 'no log yet (it printed nothing, or never started)' } };

describe('tab 7, Control Room: the view', () => {
  it('fits every row at 160x45, 120x40 and 100x30: three columns side by side from 120 columns (each with its rule), stacked below; the panes first when stacked, the roster last', () => {
    const d = data({ jobs: [...RUNNING, ended({ id: 'j0e1373', label: 'SLOW.md › long', blocks: '1 of 1 step', operation: 'o0e13703' })], decisions: [decision('i1', 'workflow run j0e1379 (SLOW.md › long) was interrupted')], turns: [sealed('abcd1234')] });
    const cd = controlData({ tails: TAILS });
    for (const [c, r] of SIZES) {
      const ctx = ctxAt(c, r, d);
      const v = controlRoomView(ctx, cd);
      for (const l of v.lines) expect(lineCells(l), `${c}x${r}: ${plain(l)}`).toBeLessThanOrEqual(ctx.width);
      const all = text(v.lines);
      expect(all).toContain(PREVIEWS_WORDS.slice(0, 20));
      if (c >= 120) {
        expect(sideBySideAt(ctx)).toBe(true);
        expect(v.lines.length).toBeLessThanOrEqual(ctx.height);
        // the two rules, at the same cells on every row
        const rules = [...plain(v.lines[0])].flatMap((ch, x) => (ch === '│' ? [x] : []));
        expect(rules.length).toBeGreaterThanOrEqual(2);
        for (const l of v.lines) for (const x of rules.slice(0, 2)) expect([...plain(l)][x]).toBe('│');
      } else {
        expect(sideBySideAt(ctx)).toBe(false);
        expect(all.indexOf('RUNNING NOW (2)')).toBeLessThan(all.indexOf('WAITING ON YOU (1)'));
        expect(all.indexOf('WAITING ON YOU (1)')).toBeLessThan(all.indexOf('RECENT (1)'));
        expect(all.indexOf('CHAT TURNS (1)')).toBeLessThan(all.indexOf('HARNESSES (6)'));
      }
      // before the first reading: the roster and the logs are said to be read, nothing is invented
      const first = controlRoomView(ctx, undefined);
      for (const l of first.lines) expect(lineCells(l)).toBeLessThanOrEqual(ctx.width);
      expect(text(first.lines)).toMatch(/reading…/);
      expect(text(first.lines)).toMatch(/reading its log…/);
      const roster = c >= 120 ? cols(first.lines)[0] : text(first.lines).slice(text(first.lines).indexOf('HARNESSES'));
      expect(roster).not.toMatch(/opencode|not installed|found/);
      // without Unicode: the ASCII marks and boxes, every row still fitted
      const ascii = controlRoomView({ ...ctx, g: glyphsFor(false) }, cd);
      for (const l of ascii.lines) expect(lineCells(l)).toBeLessThanOrEqual(ctx.width);
      expect(text(ascii.lines)).not.toMatch(/[▶●○✓✕┏╭│]/);
      expect(text(ascii.lines)).toMatch(/> running/);
    }
  });

  it('a box per running job and turn: its id, ▶ running and its label, recovery\'s words, who started it with its operation, its log\'s last lines; the selected pane\'s frame amber and heavy; ● never marks a run', () => {
    const turn: LiveTurnRow = { surface: 'repl', pid: 4243, taken: ISO(NOW - 8000), mine: false, proof: 'alive' };
    const d = data({ jobs: RUNNING });
    const cd = controlData({ tails: TAILS, turns: [turn] });
    for (const [c, r] of SIZES) {
      const ctx = ctxAt(c, r, d, 0);
      const v = controlRoomView(ctx, cd);
      const all = text(v.lines);
      const panes = flat(cols(v.lines)[c >= 120 ? 1 : 0]);
      expect(panes).toContain('RUNNING NOW (3)');
      // its mark and word whole, its label beside them where they fit (160 columns), else under them
      expect(panes).toMatch(/▶ running SLOW\.md › wait/);
      if (c === 160) expect(all).toMatch(/▶ running {2}SLOW\.md › wait/);
      expect(panes).toMatch(/still waiting/);
      // each pane read with it selected (a narrow column shows the selected one whole, and says which rows show)
      const second = flat(cols(controlRoomView(ctxAt(c, r, d, 1), cd).lines)[c >= 120 ? 1 : 0]);
      expect(second).toMatch(/j0e1372 .*▶ running FAKE job \(test\): sleep 300 left running an ended session (· )?o0e13702/);
      const third = flat(cols(controlRoomView(ctxAt(c, r, d, 2), cd).lines)[c >= 120 ? 1 : 0]);
      expect(third).toMatch(/chat turn .*▶ answering from the REPL pid 4243 (· )?since \d\d:\d\d:\d\d/);
      expect(third).toContain('Ctrl+C in the REPL stops it');
      // the items: the two jobs, then the turn, keys as the Control Room always had them
      expect(v.items.map((x) => x.item.key)).toEqual(['job:j0e1371', 'job:j0e1372', `live-turn:repl:4243:${turn.taken}`]);
      // the selected (first) pane: heavy, amber; the others light, grey
      const heavy = v.lines.flat().filter((s) => s.text.startsWith('┏'));
      expect(heavy).toHaveLength(1);
      expect(heavy[0].role).toBe('focus');
      expect(v.lines.flat().filter((s) => s.text.startsWith('╭')).every((s) => s.role === 'border')).toBe(true);
      // ● is a live connection only: the panes never draw it, and wherever it is drawn it is green (the live device, the live
      // companion: at 120 columns the roster may be clipped below them)
      expect(segsWith(v.lines, /●/).every((s) => s.role === 'live')).toBe(true);
      if (c === 160 || c === 100) expect(segsWith(v.lines, /●/)).toHaveLength(2);
      expect(all).toMatch(/○ opencode +FAKE/);
      expect(all).toMatch(/not installed/);
    }
    // side by side, an item in view knows its column's cells (a click on that row in another column is not on it)
    const v = controlRoomView(ctxAt(160, 45, d, 1), cd);
    const [a, b] = [v.items[0], v.items[1]];
    expect(a.line).toBeGreaterThanOrEqual(0);
    expect(a.x).toEqual(b.x);
    expect(a.x!.from).toBeGreaterThan(0);
    expect(columnText(v.lines, a.x!.from, a.x!.to)).toMatch(/┏━ j0e1372/);
  });

  it('with nothing running, the newest ended runs are quiet panes with their exit and receipt: green only when verified in this reading, amber with ✕ when it does not verify, quiet when not found; RECENT keeps its count', () => {
    const jobs = [
      ended({ id: 'j0e1381', label: 'SLOW.md › wait', blocks: '1 of 1 step', receipt: 'aaaa1111', operation: 'o0e13801' }),
      ended({ id: 'j0e1382', label: 'SLOW.md › long', state: 'failed', mark: 'failed', word: 'failed', exitCode: 3, receipt: 'bbbb2222' }),
      ended({ id: 'j0e1383', label: 'SLOW.md › long', state: 'cancelled', mark: 'stopped', word: 'cancelled', exitCode: null, receipt: 'cccc3333', recovery: { state: 'ended by recovery', words: 'ended by recovery: a later session\'s recovery wrote its end from what it found; nothing was run again.' } }),
      ended({ id: 'j0e1384', label: 'SLOW.md › long', blocks: '1 of 1 step', state: 'running', mark: 'unknown', word: 'stale', stale: true, recovery: { state: 'stale', words: 'stale: its record says it runs, and no process of it runs.' } }),
    ];
    const cd = controlData({
      tails: { j0e1381: { lines: ['done'] }, j0e1382: { lines: ['boom'] }, j0e1383: { lines: [] } },
      receipts: { j0e1381: { state: 'verified' }, j0e1382: { state: 'failed', reason: 'its body hash does not match' }, j0e1383: { state: 'not found', reason: 'not found on the chain read here' } },
    });
    for (const [c, r] of SIZES) {
      const v = controlRoomView(ctxAt(c, r, data({ jobs })), cd);
      const all = text(v.lines);
      // every quiet pane, as drawn with it selected
      const pane = (i: number): { lines: Line[]; text: string } => { const x = controlRoomView(ctxAt(c, r, data({ jobs }), i), cd); return { lines: x.lines, text: text(x.lines) }; };
      expect(all).toContain('RUNNING NOW (0)');
      expect(flat(cols(v.lines)[c >= 120 ? 1 : 0])).toContain('Nothing runs in this project.');
      expect(all).toContain('NEWEST ENDED RUNS (3)');
      expect(all).toContain('RECENT (4)');
      expect(flat(cols(v.lines)[c >= 120 ? 2 : 0])).toMatch(/the newest 3 are drawn as panes/);
      // the quiet panes are the first items; the fourth run is in RECENT
      expect(v.items.map((x) => x.item.key)).toEqual(['job:j0e1381', 'job:j0e1382', 'job:j0e1383', 'job:j0e1384']);
      const [p0, p1, p2] = [pane(0), pane(1), pane(2)];
      // green only for the receipt verified in this reading, and nowhere else in any pane
      const greenReceipt = (lines: readonly Line[]): string => lines.flat().filter((s) => s.role === 'live' && !/●|live/.test(s.text)).map((s) => s.text.trim()).join(' ');
      expect(greenReceipt(p0.lines)).toBe('✓ receipt aaaa1111 verified');
      for (const x of [p1, p2]) expect(['', '✓ receipt aaaa1111 verified']).toContain(greenReceipt(x.lines));
      // amber with ✕ and its words, whole (wrapped under themselves in a narrow pane, never cut)
      const failed = p1.lines.flat().filter((s) => s.role === 'failure' && !/^✕ failed$/.test(s.text)).map((s) => s.text.trim()).join(' ');
      expect(failed).toContain('✕ receipt bbbb2222 does not verify: its body hash does not match');
      expect(p2.lines.flat().filter((s) => /cccc3333/.test(s.text)).every((s) => s.role === 'secondary')).toBe(true);
      expect(flat(cols(p2.lines)[c >= 120 ? 1 : 0])).toMatch(/receipt cccc3333 \(not found on the chain read here\)/);
      expect(p0.text).toMatch(/exit 0/);
      expect(p1.text).toMatch(/exit 3/);
      expect(p1.text).toMatch(/✕ failed/);
      expect(p2.text).toMatch(/■ cancelled/);
      expect(p2.text).toMatch(/ended by recovery/);
      expect(p2.text).toMatch(/no exit code/);
      // the fourth run, in RECENT: its id and recovery's word
      expect(pane(3).text).toMatch(/j0e1384 {2}stale/);
    }
    // stacked, a recent run is one row, as the Control Room's was: the regular expressions of the recovery test match it
    const stacked = text(controlRoomView(ctxAt(100, 30, data({ jobs })), cd).lines);
    expect(stacked).toMatch(/j0e1384\s+stale\s+SLOW\.md › long · 1 of 1 step/);
  });

  it('WAITING ON YOU: the count, "nothing is done until you do it", each title whole (wrapped, never cut) with its command; a clipped column says which rows show and keeps the selection in view', () => {
    const long = 'workflow run j0e1379 (SLOW.md › long) was interrupted while long was running';
    const many = Array.from({ length: 24 }, (_, i) => ended({ id: `j0e14${String(i).padStart(2, '0')}`, label: `FAKE job (test) ${i}`, kind: 'task' }));
    const d = data({ jobs: [RUNNING[0], ...many], decisions: [decision('i1', long), decision('i2', 'a NEEDS YOU box waits')] });
    for (const [c, r] of SIZES) {
      const last = 1 + 2 + many.length - 1;
      const ctx = ctxAt(c, r, d, last);
      const v = controlRoomView(ctx, controlData({ tails: TAILS }));
      const all = text(v.lines);
      if (c >= 120) {
        // from the top (the first pane selected), the right column starts with what waits on you
        const fromTop = flat(cols(controlRoomView(ctxAt(c, r, d, 0), controlData({ tails: TAILS })).lines)[2]);
        expect(fromTop).toContain('WAITING ON YOU (2)');
        expect(fromTop).toContain('⚠ nothing is done until you do it');
        // the right column: clipped, it says its rows; the selected run (the last) is in view, its row marked
        const it = v.items[last];
        expect(it.line).toBeGreaterThanOrEqual(0);
        const right = columnText(v.lines, it.x!.from, it.x!.to);
        expect(right).toMatch(/\d+–\d+ of \d+/);
        expect(right).toMatch(/▸ ✓ j0e1423/);
        // an item out of view has no line
        expect(v.items.some((x) => x.line === -1)).toBe(true);
        // the decision's title, whole: every word of it in the column (from the top, with the selection at the top)
        const top = controlRoomView(ctxAt(c, r, d, 1), controlData({ tails: TAILS }));
        const col = columnText(top.lines, top.items[1].x!.from, top.items[1].x!.to).replace(/\s+/g, ' ');
        expect(col).toContain(`⚠ ${long}`.replace(/\s+/g, ' '));
        expect(col).toContain('/run SLOW.md long');
      } else {
        expect(all).toContain('WAITING ON YOU (2)');
        expect(all).toMatch(/nothing is done until you do it/);
        expect(all.replace(/\s+/g, ' ')).toContain(`⚠ ${long}`);
      }
    }
  });

  it('the roster: FAKE says FAKE, running only by its record, the surfaces as the frame says them (● live only for an observed answer), the devices with their words; the selected run\'s detail beside the panes', () => {
    const op = 'o0e13701';
    const detail: RunDetail = {
      version: 1, operation: op, parent: null, children: [], project: { name: 'tray', root: ROOT, id: 'fakeid' },
      objective: { value: '/run SLOW.md wait', from: 'FIXTURE' }, sourceRevision: null,
      verdict: { state: 'running', words: 'running: FIXTURE verdict words', from: 'FIXTURE' },
      stage: { current: 'wait', done: 0, total: 1, from: 'FIXTURE' }, exits: [], freshness: { state: 'unknown', why: 'FIXTURE' },
      acceptance: { state: 'not reviewed' }, worker: {}, time: { startedAt: ISO(NOW - 12_000), endedAt: null, elapsedMs: 12_000 },
      prediction: null, checks: [], files: [], receipts: [], cost: { usd: null, measured: false, why: 'FIXTURE' }, summary: { path: null }, next: null, unknown: [],
    };
    const d = data({ jobs: [RUNNING[0]], details: { [op]: { state: 'ready', value: detail, at: NOW } }, companion: 'configured' });
    // stacked (a wide column): every entry on one row, its whole word; names padded to the longest of their group
    const wide = text(controlRoomView(ctxAt(100, 30, d), controlData({ tails: TAILS })).lines);
    expect(wide).toMatch(/○ opencode  FAKE stand-in/);
    expect(wide).toMatch(/▶ hermes    running dp_fake1/);
    expect(wide).toMatch(/· pi        not installed/);
    expect(wide).toMatch(/· minds     not installed/);
    expect(wide).toMatch(/▶ Workbench running \(this one\)/);
    expect(wide).toMatch(/\? REPL      not recorded/);
    expect(wide).toMatch(/○ companion configured, served here/);
    expect(wide).toMatch(/○ Studio    configured/);
    expect(wide).toMatch(/● fake-live live, reached 5 min ago/);
    expect(wide).toMatch(/○ fake-old  reached 3 h ago/);
    expect(wide).toMatch(/✕ fake-gone unreachable/);
    expect(wide).toMatch(/▶ 1 remote job running/);
    // side by side at 160 columns (a narrow roster): the shorter words, the lanes not installed sharing one entry, nothing cut
    const v = controlRoomView(ctxAt(160, 45, d), controlData({ tails: TAILS }));
    const all = text(v.lines);
    expect(all).toMatch(/○ opencode  FAKE /);
    expect(all).toMatch(/▶ hermes    running /);
    expect(all.replace(/ +│[^\n]*/g, '').replace(/\n +/g, ' ')).toMatch(/· not installed: pi, openhands, jcode, minds/);
    expect(all).toMatch(/○ companion configured /);
    expect(all).toMatch(/● fake-live live /);
    expect(all).toMatch(/✕ fake-gone/);
    expect(all).not.toMatch(/…\s*│/);
    expect(segsWith(v.lines, /^● $/).map((s) => s.role)).toEqual(['live']);
    const right = flat(cols(v.lines)[2]);
    expect(right).toContain(`RUN DETAIL · ${op}`);
    expect(all).toMatch(/Verdict {3}running: FIXTURE/);
    expect(right).toContain('Verdict running: FIXTURE verdict words');
    expect(right).toContain('Stage wait · 0 of 1 done');
    expect(right).toContain('i: Context\'s Inspector has the whole of it');
    // the run detail of a turn being answered, and of a job naming no operation
    const t: LiveTurnRow = { surface: 'workbench', pid: process.pid, taken: ISO(NOW - 4000), mine: true, proof: 'alive' };
    const own = liveTurnDetail(t, 60, g, NOW, { text: 'FAKE', answer: 'FIXTURE answer words', state: 'sending', lines: [], sent: true, tools: [{ name: 'read_file', phase: 'start' }], at: NOW, operation: 'o0e13709' });
    const words = text(own);
    expect(words).toMatch(/From +the Workbench/);
    expect(words).toMatch(/Stops +Esc in its composer stops it/);
    expect(words).toMatch(/▶ read_file running/);
    expect(words).toMatch(/Answer +20 characters so far/);
    expect(words).not.toContain('FIXTURE answer words');
  });
});
