// R6 (H141; the interaction review of a77d80d, defect 3): the Workbench learns of a chat turn another process of its project
// answers as soon as the turn's hold is written (src/workbench/turn-holds.ts), not at its next workspace-frame reading: the run
// line says it runs and Stop current names it within half a second; x and Enter on Stop the turn read the holds before they
// answer, so x never says "nothing runs" while a turn is held, even before the watch has looked; the turn's end shows as soon
// as its hold is let go; a hold whose writer has ended is no running turn, and is left where it is. The review saw x answer
// "Stop current: nothing runs in tray." for the first 1 to 4.5 s of a REPL turn, which went on.
//
// Drawn by the Workbench's own frame (Controller.frame, the rows Ink prints) over a real Timmy home in a temporary folder: a
// tray-workflow project made by the starter code and the REPL's own Workspace; the turns' receipts sealed for real (signed and
// chained) by sealTurn into the project's pinned store. FAKE or FIXTURE here, each labelled where it is made:
// - a turn being answered in the REPL is a hold this test takes with the REPL's own takeTurnHold (no REPL runs: the real
//   terminal's is tests/workbench-turn-holds-pty.test.ts); a FAKE REPL answers a stop asked of it as the REPL's own turn does
//   (watchTurnStop): a cancelled turn's receipt (FIXTURE facts) naming its turn_id and who asked, then its hold let go;
// - a stale hold is a hold file this test writes for a process that does not run;
// - the run detail's and the chat session's producers have none; the browser opener and the server starts are FAKE.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { projectStore } from '../src/agent/chat-session.js';
import { CHAT_HOLD_SCHEMA, CHAT_TURNS_DIR, takeTurnHold, watchTurnStop, type TurnHold } from '../src/agent/chat-turn.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { sealTurn } from '../src/repl/seal.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { routeOf } from '../src/workbench/hub.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { HOLDS_EVERY_MS, HoldWatch, quickTurns } from '../src/workbench/turn-holds.js';
import { useProcessTableReader } from '../src/ops/process-proof.js';
import { pageActions } from '../src/workbench/views.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];
const holds: TurnHold[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-turn-holds-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const h of holds.splice(0)) h.release();
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  // the project's store, pinned in its folder: the chain the Workbench reads when TIMMY_STORE is not set
  mkdirSync(join(made.root, '.timmy'), { recursive: true });
  writeFileSync(join(made.root, '.timmy', 'store-pin'), join(made.root, '.timmy', 'receipts'));
  return made;
}

/** A Workbench on the project. `slowMs` an hour: no slow reading reads the frame again while a test runs; `watch` false: the
 *  holds' watch never looks on its own (only x and Enter read them). */
function workbench(p: { name: string; root: string; chosen: boolean }, o: { watch?: boolean } = {}): Controller {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({ glyphs: glyphSet(true), env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, p);
  spaces.push(ws);
  const c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) },
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 3_600_000,
    ...(o.watch === false ? { holdsEveryMs: 3_600_000, holdWatch: false } : {}),
  });
  opened.push(c);
  return c;
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(20);
  }
}

/** Row 2's words as drawn at 160x45 (through its bottom edge: the run state and Stop current). */
function top(c: Controller): string {
  const fr = c.frame(160, 45);
  const rect = fr.regions.top!.rect;
  const text = screenText(fr.screen);
  const out: string[] = [];
  for (let y = rect.y + 1; y <= rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const ch of text[y] ?? '') { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(y === rect.y + rect.h - 1 ? row.replace(/[─━]/g, ' ') : row);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}
const screen = (c: Controller): string => screenText(c.frame(160, 45).screen).join('\n');

/** A turn being answered "in the REPL": its hold, as the REPL takes it; with `answers`, a FAKE REPL ends it when a stop is asked
 *  of it, as the REPL's own turn does (its receipt sealed cancelled, naming the turn and who asked; then the hold let go). */
function replTurn(p: { name: string; root: string }, asked: Array<string | null>, answers = true): TurnHold {
  const held = takeTurnHold(p.root, 'repl');
  if (!held.ok) throw new Error(held.lines.join(' '));
  const hold = held.hold;
  holds.push(hold);
  if (answers) {
    const watch = watchTurnStop(p.root, hold.id, (by) => {
      asked.push(by);
      sealTurn({ prompt: 'FIXTURE: a REPL question', answer: '', steps: 0, spend: 0, costMeasured: false, ms: 500, status: 'cancelled', surface: 'repl', model: 'fixture/chat-model', project: p.name, projectId: projectId(p.root), turnId: hold.id, stoppedBy: by ?? 'unknown' }, projectStore(p.root));
      watch.close();
      hold.release();
    }, 20);
  }
  return hold;
}

describe('the Workbench sees another process\'s chat turn at once (R6 H141; the interaction review of a77d80d, defect 3)', () => {
  it('a turn held by another surface shows in the run line and Stop current within half a second, with no frame reading in between; x asks first, then y asks it to stop; its end shows within half a second of its hold let go', async () => {
    const p = trayProject('holds-watch');
    const c = workbench(p);
    c.start();
    await until('the frame', () => c.data.frame, 10_000, () => screen(c));
    expect(top(c)).toContain('run: idle');
    const framed = c.data.frame!.revision;

    const asked: Array<string | null> = [];
    const taken = Date.now();
    const turn = replTurn(p, asked);
    await until('the run line naming the REPL\'s turn', () => top(c).includes('run: 1 running (the chat turn in the REPL)'), 2000, () => top(c));
    const seenIn = Date.now() - taken;
    expect(seenIn, `the run line named the turn ${seenIn} ms after its hold was written`).toBeLessThan(500);
    expect(top(c)).toContain('[x] Stop current: the chat turn in the REPL (Ctrl+C in the REPL stops it there; x here asks you first)');
    // the frame, read again since (its log and actions follow, at most once a second), names the same turn by its identity
    await until('the frame naming the turn', () => c.data.frame?.activity.chatTurn?.id === turn.id, 5000, () => screen(c));
    expect(c.data.frame!.revision).not.toBe(framed);

    // x: it asks first (R7 H150), then y: the turn is asked to stop by its identity; the FAKE REPL ends it, seals its receipt
    // and lets its hold go
    await c.stop();
    expect(c.ui.overlay).toMatchObject({ kind: 'confirm-stop', turn: { id: turn.id, where: 'the REPL' } });
    c.key('y', {});
    expect(c.ui.flash?.text).toBe('Stop asked of the turn being answered in the REPL (x, then y): it stops there as Ctrl+C in the REPL would, and its end shows here once its receipt is sealed.');
    await until('the stop answered by the REPL', () => asked.length === 1, 5000);
    expect(asked).toEqual(['workbench']);
    const released = Date.now();
    await until('the run line idle again', () => top(c).includes('run: idle'), 2000, () => top(c));
    expect(Date.now() - released, 'the run line idle again after the hold was let go').toBeLessThan(500);
    // its end as its receipt says it, read as its hold was let go (not at a slow reading)
    expect(c.data.turns?.find((t) => t.turn === turn.id)).toMatchObject({ surface: 'repl', state: 'stopped', stoppedBy: 'workbench' });
  }, 30_000);

  it('x before the watch has looked: the holds are read before x answers, so a turn just held is the one x asks about (then y asks it to stop), never "nothing runs"; with no turn held x says nothing runs; a turn the screen named that has ended since is asked, and x says it had ended', async () => {
    const p = trayProject('holds-x');
    const c = workbench(p, { watch: false });
    c.start();
    await until('the frame', () => c.data.frame, 10_000, () => screen(c));
    await c.stop();
    expect(c.ui.flash?.text).toBe('Stop current: nothing runs in holds-x.');

    const asked: Array<string | null> = [];
    replTurn(p, asked);
    // nothing has looked since: the screen still says idle
    expect(top(c)).toContain('run: idle');
    await c.stop();
    expect(c.ui.overlay).toMatchObject({ kind: 'confirm-stop' });
    c.key('y', {});
    expect(c.ui.flash?.text).toBe('Stop asked of the turn being answered in the REPL (x, then y): it stops there as Ctrl+C in the REPL would, and its end shows here once its receipt is sealed.');
    await until('the stop answered by the REPL', () => asked.length === 1, 5000);
    expect(asked).toEqual(['workbench']);

    // a turn the screen names (read by x a moment ago) that ends before the next x: x asks it, and says it had ended
    const second = replTurn(p, asked, false);
    await c.stop();
    expect(c.ui.overlay).toMatchObject({ kind: 'confirm-stop', turn: { id: second.id } });
    c.key('', { escape: true });
    expect(c.ui.flash?.text).toBe('Kept: the chat turn in the REPL goes on (nothing was asked of it).');
    expect(top(c)).toContain('run: 1 running (the chat turn in the REPL)');
    second.release();
    await c.stop();
    expect(c.ui.flash?.text).toBe('Nothing stopped (x): that chat turn is not being answered now (it ended, or it was never this project\'s).');
    expect(top(c)).toContain('run: idle');
    await c.stop();
    expect(c.ui.flash?.text).toBe('Stop current: nothing runs in holds-x.');
  }, 30_000);

  it('Enter on Stop the turn reads the holds first: drawn not available a moment before (no reading had seen the turn), it names where the turn is done and asks nothing of it (R7 H150: Enter never stops another surface\'s turn)', async () => {
    const p = trayProject('holds-enter');
    const c = workbench(p, { watch: false });
    c.start();
    c.selectPage('chat');
    await until('the frame', () => c.data.frame, 10_000, () => screen(c));
    const stopAction = () => pageActions(c).acts.find((a) => routeOf(a).kind === 'abort');
    expect(stopAction()).toMatchObject({ enabled: false });
    const asked: Array<string | null> = [];
    replTurn(p, asked);
    // the bar as drawn before any reading saw the turn: Stop the turn not available; Enter on it reads the holds, then says
    // the turn is the REPL's, stopped there, and asks nothing of it
    const drawn = stopAction()!;
    expect(drawn.enabled).toBe(false);
    await c.runAction(drawn);
    expect(c.ui.flash?.text).toBe('3 Stop the turn is done in the REPL (Ctrl+C in the REPL that sent it): Enter here does not stop it. x asks you first, then asks it to stop there.');
    // the bar now names the turn, done in the REPL; Enter on it again asks nothing
    expect(stopAction()).toMatchObject({ enabled: true, primary: true, doneIn: 'repl', away: 'the REPL' });
    await c.runAction(stopAction()!);
    await sleep(300);
    expect(asked).toEqual([]);
  }, 30_000);

  it('the holds read at once without the process table (quickTurns): a fresh hold of a process that runs is its writer\'s; an older one asks the process table (null); a hold whose process has ended is no turn; the watch proves a held turn by the table only every few seconds', async () => {
    const p = trayProject('holds-quick');
    const dir = join(p.root, CHAT_TURNS_DIR);
    mkdirSync(dir, { recursive: true });
    // FIXTURE: another process (a sleep this test starts) as a hold's writer, its start as the process table would give it
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const started = new Date().toISOString();
      const hold = (name: string, pid: number) => writeFileSync(join(dir, name), `${JSON.stringify({ schema: CHAT_HOLD_SCHEMA, surface: 'repl', owner: { pid, started }, taken: started })}\n`);
      const fresh = `t${child.pid}-0000aaaa.json`;
      hold(fresh, child.pid!);
      // the process table is never asked for a fresh hold (counted through process-proof's own seam)
      let asked = 0;
      const put = useProcessTableReader({ all: () => { asked++; return undefined; }, one: () => { asked++; return undefined; } });
      try {
        expect(quickTurns(p.root)).toEqual([{ id: fresh.slice(0, -5), surface: 'repl', pid: child.pid, taken: started, mine: false, proof: 'alive' }]);
        expect(asked).toBe(0);
        // a hold written 60 s ago: its pid may be another process's now, so the full reading proves it
        utimesSync(join(dir, fresh), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
        expect(quickTurns(p.root)).toBeNull();
        expect(asked).toBe(0);
      } finally { put(); }
      rmSync(join(dir, fresh));
      // a hold whose process has ended: no turn, left where it is
      hold(`t${2 ** 22 + 9}-0000bbbb.json`, 2 ** 22 + 9);
      expect(quickTurns(p.root)).toEqual([]);
      expect(readdirSync(dir)).toContain(`t${2 ** 22 + 9}-0000bbbb.json`);

      // the watch: a fresh hold is seen with no process-table reading; it is proven by the table once PROOF_MS has passed
      hold(fresh, child.pid!);
      const seen: string[][] = [];
      let tableReads = 0;
      const put2 = useProcessTableReader({ all: () => { tableReads++; return undefined; }, one: (pid) => { tableReads++; return pid === child.pid ? 0 : undefined; } });
      const w = new HoldWatch({ root: () => p.root, now: () => Date.now(), onChange: (r) => seen.push(r.turns.map((t) => t.id)), everyMs: 20, proofMs: 400, watch: false });
      try {
        w.start();
        expect(seen[0]).toEqual([fresh.slice(0, -5)]);
        expect(tableReads).toBe(0);
        await sleep(700);
        expect(tableReads).toBeGreaterThan(0);
      } finally { w.close(); put2(); }
    } finally { child.kill('SIGKILL'); }
  }, 30_000);

  it('R8 (H156; R7\'s open item A): the first turn of a project whose chat-turns folder was not there when the watch began is seen at once, not at the next listing (the watch is on .timmy until the folder is made, then on the folder: its end is seen at once too)', async () => {
    const p = trayProject('holds-first');
    const dir = join(p.root, CHAT_TURNS_DIR);
    expect(existsSync(dir), 'no chat-turns folder before the first turn').toBe(false);
    const seen: Array<{ at: number; ids: string[] }> = [];
    // the listing every 10 s: what this test sees within its 2 s, a watch saw
    const w = new HoldWatch({ root: () => p.root, now: () => Date.now(), onChange: (r) => seen.push({ at: Date.now(), ids: r.turns.map((t) => t.id) }), everyMs: 10_000 });
    const within = async (what: string, ok: () => boolean, from: number): Promise<number> => {
      for (const end = from + 2000; Date.now() < end; await sleep(5)) if (ok()) return Date.now() - from;
      throw new Error(`${what} not seen in 2 s (the listing looks every 10 s here): ${JSON.stringify(seen)}`);
    };
    try {
      w.start();
      expect(seen.map((s) => s.ids)).toEqual([[]]);
      // the REPL's own takeTurnHold makes the folder and writes the hold (this process's: a hold of this process is its own)
      const t0 = Date.now();
      const taken = takeTurnHold(p.root, 'repl');
      if (!taken.ok) throw new Error(taken.lines.join(' '));
      holds.push(taken.hold);
      const heldIn = await within('the first hold', () => seen.some((s) => s.ids.includes(taken.hold.id)), t0);
      expect(heldIn, `the first hold seen ${heldIn} ms after it was written`).toBeLessThan(1000);
      // its end, seen by the watch now on the chat-turns folder itself (a watch on .timmy is not told of a change inside it)
      const t1 = Date.now();
      taken.hold.release();
      const endedIn = await within('the hold let go', () => seen.at(-1)!.ids.length === 0 && seen.at(-1)!.at >= t1, t1);
      expect(endedIn, `the hold's end seen ${endedIn} ms after it was let go`).toBeLessThan(1000);
    } finally { w.close(); }
  }, 30_000);

  it('a hold whose writer has ended is no running turn: the run line stays idle, x says nothing runs, and the hold is left where it is (read only)', async () => {
    const p = trayProject('holds-stale');
    const c = workbench(p);
    c.start();
    await until('the frame', () => c.data.frame, 10_000, () => screen(c));
    // FIXTURE: a hold written for a process that does not run (pid 2^22 + 7, started in 2001)
    const dir = join(p.root, CHAT_TURNS_DIR);
    mkdirSync(dir, { recursive: true });
    const name = `t${2 ** 22 + 7}-0badc0de.json`;
    writeFileSync(join(dir, name), `${JSON.stringify({ schema: CHAT_HOLD_SCHEMA, surface: 'repl', owner: { pid: 2 ** 22 + 7, started: '2001-01-01T00:00:00.000Z' }, taken: '2001-01-01T00:00:01.000Z' })}\n`);
    await sleep(HOLDS_EVERY_MS * 3);
    expect(c.data.holds?.turns).toEqual([]);
    expect(top(c)).toContain('run: idle');
    await c.stop();
    expect(c.ui.flash?.text).toBe('Stop current: nothing runs in holds-stale.');
    expect(readdirSync(dir)).toContain(name);
  }, 30_000);
});
