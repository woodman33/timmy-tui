/**
 * Round R4 (H102, the operator's gap 6): the tray starter's guided approval example, templates/tray-workflow/APPROVAL.md:
 * one harmless block whose command is a destructive shell command (it makes scratch/x and deletes it), and words that say
 * what the NEEDS YOU box is, that y allows it once and that the board will not run it. Seeing an approval needed a
 * hand-written document before.
 *
 * Real: the starter's own files, copied as `/project new … --from tray-workflow` copies them; the Workspace's /workflows and
 * /run (its NEEDS YOU gate, src/repl/workflow-gate.ts and approvals.ts); the job manager's child processes; the files the
 * block writes; the receipt chain; `timmy act` as a real child process; and, where tmux is installed, the REPL itself
 * (`timmy repl`, the CLI through tsx) in a real terminal, its box answered with a real key.
 * FAKE, each labelled where it is used:
 * - upmd is tests/fixtures/fake-upmd.mjs, a TEST DOUBLE of upmd 0.2.7's --ci behaviour (each block runs for real through
 *   sh): upmd itself is not installed here;
 * - in the Workspace cases, the person who answers the box is the test's `ask`, as tests/workflow-blocks.test.ts does;
 * - the REPL's model key is a placeholder: no message is sent, and no model is asked.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyStarter } from '../src/project/starters.js';
import { folderProject } from '../src/project/index.js';
import { waitingApprovals, type ApprovalRequest, type Decision, type WaitingApproval } from '../src/repl/approvals.js';
import { Workspace } from '../src/repl/workspace.js';
import { riskyBlocks } from '../src/repl/workflow-gate.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, readChain, verifyChain, type Receipt } from '../src/utils/receipts.js';
import { BLOCK_RECEIPT_KIND } from '../src/workflows/block-receipts.js';
import { parseWorkflow, runOrder } from '../src/workflows/upmd.js';
import { act, CLI, FAKE_UPMD, opsKit, replOf, REPO, sandbox, text, TSX } from './helpers/ops-sandbox.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';

const APPROVAL = path.join(REPO, 'templates', 'tray-workflow', 'APPROVAL.md');
const COMMAND = 'mkdir -p scratch && touch scratch/x && rm scratch/x';
const TMUX = String(spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!TMUX) console.warn('tray-approval: no tmux here, so the REPL in a real terminal is skipped');
const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);
const temp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); kit.dirs.push(d); return d; };
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
async function until<T>(what: string, get: () => T | undefined | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** A project made from the starter (its four files), and the REPL's Workspace on it; `ask`: the person at the NEEDS YOU box. */
function project(ask?: (req: ApprovalRequest) => Promise<Decision>): { root: string; ws: Workspace; notes: string[] } {
  const root = path.join(temp('h102-approval-'), 'mytray');
  expect(copyStarter('tray-workflow', root)).toEqual({ files: ['APPROVAL.md', 'README.md', 'recipes/tray.params.json', 'WORKFLOW.md'] });
  const notes: string[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { ...process.env, UPMD_BIN: FAKE_UPMD }, onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')), openWeb: (u) => u, link: (t) => t,
    seal: (input) => appendReceipt('runs', input, root).hash.slice(7, 15),
    receipts: () => readChain('runs', root),
    jobsDir: path.join(temp('h102-jobs-'), 'jobs'), chdir: () => {}, recoverAtStart: false, roomTools: async () => [],
    ...(ask ? { askPerson: ask } : {}),
  }, folderProject(root));
  kit.spaces.push(ws);
  return { root, ws, notes };
}
const typed = (ws: Workspace, args: string) => ws.operate(`/run ${args}`, 'repl', () => ws.run(args));
const chainOf = (root: string): Receipt[] => readChain('runs', root);

describe('APPROVAL.md, the document', () => {
  it('holds one block, tidy: harmless, and a destructive shell command by Timmy\'s rule, so a run of it needs a person', () => {
    const doc = fs.readFileSync(APPROVAL, 'utf8');
    const blocks = parseWorkflow(doc);
    expect(blocks.map((b) => [b.index, b.name, b.lang, b.deps, b.code])).toEqual([[1, 'tidy', 'bash', [], COMMAND]]);
    expect(runOrder(blocks, 'tidy')).toEqual({ order: ['tidy'], missing: [] });
    expect(riskyBlocks(blocks, ['tidy']).map((b) => [b.name, b.command, b.reason])).toEqual([['tidy', COMMAND, 'a destructive shell command on this machine']]);
  });

  it('says what the NEEDS YOU box is, that y allows it once, and that the board will not run it, with the line to type', () => {
    const words = fs.readFileSync(APPROVAL, 'utf8').replace(/\s+/g, ' ');
    expect(words).toContain('Type `/run APPROVAL.md tidy` in the REPL. Before upmd runs anything, the REPL shows a NEEDS YOU box: the run, the block and its whole command, and why it asks.');
    expect(words).toContain('`y` allows it once: this run, with the command as this document holds it now. The next `/run` asks again.');
    expect(words).toContain('`n`, Esc or Enter deny it: nothing runs and nothing is sealed.');
    expect(words).toContain('The board will not run it: its Run cannot show the box, so it is refused before anything runs, and the Control Room names the line to type in the REPL instead.');
    expect(words).toContain('a command with `rm`, `sudo`, `chmod`, `chown`, `dd` or `mkfs` in it');
    expect(words).not.toMatch(/\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]/i);
  });
});

describe('/project new --from tray-workflow, then /workflows and /run APPROVAL.md tidy (the Workspace; the person FAKE)', () => {
  it('/project new copies it and /workflows lists it with its block, beside WORKFLOW.md', async () => {
    const s = sandbox(kit, 'h102-workflows-');
    const { ws } = replOf(kit, s);
    expect(text(ws.project_('new mytray --from tray-workflow'))).toContain('Made mytray from tray-workflow: 4 files, yours to edit.');
    const root = path.join(s.home, 'timmy', 'projects', 'mytray');
    expect(fs.readFileSync(path.join(root, 'APPROVAL.md'))).toEqual(fs.readFileSync(APPROVAL));
    const listed = text(await ws.workflows('')).split('\n');
    expect(listed[0]).toMatch(/^ {2}Workflows in mytray\W+upmd 0\.2\.7$/);
    const at = listed.findIndex((l) => l.trim() === 'APPROVAL.md');
    expect(at, listed.join('\n')).toBeGreaterThan(0);
    expect(listed[at + 1].trimEnd()).toBe('     1 tidy');
    expect(listed.some((l) => l.trim() === 'WORKFLOW.md')).toBe(true);
  });

  it('y (allow once): the box names the run, the block and its command before anything runs; the block runs once and its answer is sealed with the prediction', async () => {
    let asked: ApprovalRequest | undefined;
    let waiting: WaitingApproval[] = [];
    let ranBefore = true;
    let asks = 0;
    // FAKE person: answers the box with y (allow once) the first time, after looking at what waits; n the next time
    const { root, ws } = project(async (req) => {
      asks += 1;
      if (asks > 1) return 'deny';
      asked = req;
      waiting = waitingApprovals();
      ranBefore = fs.existsSync(path.join(root, 'scratch')) || chainOf(root).length > 0;
      return 'once';
    });
    const said = text(await typed(ws, 'APPROVAL.md tidy'));
    expect(ranBefore).toBe(false);
    expect(asked).toEqual({
      tool: '/run APPROVAL.md tidy', reason: 'runs a destructive shell command on this machine: tidy', summary: `tidy: ${COMMAND}`,
      detail: `tidy (block 1 of APPROVAL.md):\n  ${COMMAND}\nupmd runs tidy; approved together, before the run`, session: false,
    });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ tool: '/run APPROVAL.md tidy', words: { title: `NEEDS YOU: /run APPROVAL.md tidy (tidy: ${COMMAND})`, keys: true } });
    expect(said).toMatch(/Approved\s+tidy, once, in its NEEDS YOU box/);
    const job = await until('the run\'s job', () => ws.jobs.list().find((j) => j.label === 'APPROVAL.md › tidy'));
    expect((await ws.jobs.done(job.id)).state).toBe('completed');
    await sleep(80);
    // it made scratch/x and deleted it: the empty folder stays
    expect(fs.readdirSync(path.join(root, 'scratch'))).toEqual([]);
    const chain = chainOf(root);
    expect(chain.map((r) => r.kind)).toEqual(['predict', BLOCK_RECEIPT_KIND, 'workflow']);
    expect(chain[0]).toMatchObject({
      prediction: { doc: 'APPROVAL.md', block: 'tidy', order: ['tidy'], risky: [{ name: 'tidy', reason: 'a destructive shell command on this machine' }] },
      decisions: [{ decision: 'allow once', effect: 'run tidy', tier: 'NEEDS YOU (the person, in its box)', reason: 'tidy: a destructive shell command on this machine' }],
    });
    expect(chain[1]).toMatchObject({ block: { name: 'tidy' } });
    expect(new Set(chain.map((r) => r.operation_id)).size).toBe(1);
    expect(verifyChain('runs', root).ok).toBe(true);
    // allowed once: the next run asks again (and is denied this time)
    expect(text(await typed(ws, 'APPROVAL.md tidy'))).toBe('  Not run: you denied it in its NEEDS YOU box. Nothing ran, and nothing was sealed.');
    expect(asks).toBe(2);
    expect(chainOf(root)).toHaveLength(3);
  }, 120_000);

  it('n (deny): nothing runs and nothing is sealed', async () => {
    const { root, ws } = project(async () => 'deny');
    expect(text(await typed(ws, 'APPROVAL.md tidy'))).toBe('  Not run: you denied it in its NEEDS YOU box. Nothing ran, and nothing was sealed.');
    expect(ws.jobs.list()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'scratch'))).toBe(false);
    expect(chainOf(root)).toEqual([]);
  }, 60_000);

  it('the board will not run it: its Run is refused before anything runs, and Waiting on you gives the line to type in the REPL', async () => {
    let asks = 0;
    const { root, ws } = project(async () => { asks += 1; return 'once'; });
    const refused = text(await ws.operate('/run APPROVAL.md tidy', 'board', () => ws.run('APPROVAL.md tidy', { from: 'board' })));
    expect(refused).toBe(`  Not run: tidy (${COMMAND}) is a destructive shell command on this machine, which needs a person, and the board cannot ask you. Type this in the REPL instead: /run APPROVAL.md tidy`);
    expect(asks).toBe(0);
    expect(fs.existsSync(path.join(root, 'scratch'))).toBe(false);
    expect(chainOf(root)).toEqual([]);
    const listed = text(await ws.decisions(''));
    expect(listed).toContain(`! NEEDS YOU: /run APPROVAL.md tidy from the board (tidy: ${COMMAND})  blocks a requested run`);
    expect(listed).toContain('type    /run APPROVAL.md tidy');
  }, 60_000);

  it('timmy act refuses it as needing a person (exit 2), with the line to type in the REPL; nothing runs', async () => {
    const s = sandbox(kit, 'h102-act-');
    fs.rmSync(s.root, { recursive: true, force: true });
    expect(copyStarter('tray-workflow', s.root)).toHaveProperty('files');
    const env = { ...s.env, UPMD_BIN: FAKE_UPMD };
    const r = await act(kit, s, ['/run APPROVAL.md tidy', '--wait'], { env }).done;
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(`Not run: tidy (${COMMAND}) in APPROVAL.md is a destructive shell command on this machine, which needs a person. Type this in the REPL instead: /run APPROVAL.md tidy`);
    expect(fs.existsSync(path.join(s.root, 'scratch'))).toBe(false);
  }, 120_000);
});

describe.skipIf(!TMUX)('the REPL in a real terminal (tmux): /project new, /workflows and APPROVAL.md\'s NEEDS YOU box, answered with a real key', () => {
  it('the box names the run, the block and its whole command; y runs it once; the run\'s receipts name the answer', async () => {
    const dir = temp('h102-repl-');
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    // a terminal of its own: its HOME, Timmy home and store; upmd the TEST DOUBLE; a placeholder model key (nothing is sent)
    const env: NodeJS.ProcessEnv = {
      ...withoutRunner(process.env), HOME: home, TIMMY_HOME: path.join(home, 'timmy'), TIMMY_STORE: path.join(dir, 'store'), TIMMY_REPO_ROOT: dir,
      OPENROUTER_API_KEY: 'sk-or-test-placeholder', TIMMY_PALETTE: 'night', UPMD_BIN: FAKE_UPMD,
      TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor',
    };
    delete env.TIMMY_OPERATION;
    delete env.NO_COLOR;
    const tmux = (...args: string[]): string => execFileSync('tmux', ['-L', 'h102', ...args], { env, encoding: 'utf8', timeout: 10_000 });
    const screen = (): string => tmux('capture-pane', '-p', '-J', '-S', '-400', '-t', 't');
    const waitFor = async (re: RegExp, ms = 60_000): Promise<string> => until(`${re} on the screen`, () => { const s = screen(); return re.test(s) ? s : undefined; }, ms)
      .catch((e: unknown) => { throw new Error(`${e instanceof Error ? e.message : String(e)}:\n${screen()}`); });
    const type = (line: string): void => { tmux('send-keys', '-t', 't', '-l', line); tmux('send-keys', '-t', 't', 'Enter'); };
    try {
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '120', '-y', '50', '-c', dir, 'bash', '--norc', '-c', `"${TSX}" "${CLI}" repl; echo "EXIT=$?"; sleep 60`);
      await waitFor(/Enter to send/, 90_000);
      type('/project new mytray --from tray-workflow');
      await waitFor(/Made mytray from tray-workflow: 4 files, yours to edit\.[\s\S]*Enter to send/);
      const root = path.join(home, 'timmy', 'projects', 'mytray');
      expect(fs.readFileSync(path.join(root, 'APPROVAL.md'))).toEqual(fs.readFileSync(APPROVAL));
      type('/workflows');
      const listed = await waitFor(/APPROVAL\.md\s*\n\s+1 tidy[\s\S]*WORKFLOW\.md[\s\S]*Enter to send/);
      expect(listed).toMatch(/Workflows in mytray\W+upmd 0\.2\.7/);
      type('/run APPROVAL.md tidy');
      const asked = await waitFor(/NEEDS YOU/);
      expect(asked).toContain('/run APPROVAL.md tidy');
      expect(asked).toContain(COMMAND);
      expect(asked).toContain('runs a destructive shell command on this machine: tidy');
      expect(asked).toMatch(/Needs you\s+tidy: mkdir -p scratch && touch scratch\/x && rm scratch\/x/);
      expect(asked).toContain('Predicted  tidy, each exits 0 · nothing runs or is sealed until you answer');
      expect(asked).not.toContain('allow for session');
      // nothing of the run has started while the box waits
      expect(fs.existsSync(path.join(root, 'scratch'))).toBe(false);
      await sleep(400); // keys in the first 300 ms after the box appears are ignored (type-ahead guard)
      tmux('send-keys', '-t', 't', 'y');
      // The terminal's chain is its store's runs.jsonl (TIMMY_STORE); it also carries the bus's events: receipts have a prev_hash.
      const store = path.join(dir, 'store', 'runs.jsonl');
      const receipts = (): Receipt[] => (fs.existsSync(store) ? fs.readFileSync(store, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Receipt).filter((r) => typeof r.prev_hash === 'string' && typeof r.hash === 'string') : []);
      const chain = await until('the run\'s own receipt', () => { const c = receipts(); return c.some((r) => r.kind === 'workflow') ? c : undefined; }, 90_000)
        .catch((e: unknown) => { throw new Error(`${e instanceof Error ? e.message : String(e)}:\n${screen()}`); });
      await waitFor(/Approved\s+tidy, once, in its NEEDS YOU box/);
      expect(fs.readdirSync(path.join(root, 'scratch'))).toEqual([]);
      const run = chain.filter((r) => ['predict', BLOCK_RECEIPT_KIND, 'workflow'].includes(r.kind));
      expect(run.map((r) => r.kind)).toEqual(['predict', BLOCK_RECEIPT_KIND, 'workflow']);
      expect(run[0]).toMatchObject({ prediction: { doc: 'APPROVAL.md', block: 'tidy', risky: [{ name: 'tidy' }] }, decisions: [{ decision: 'allow once' }] });
      expect(run[1]).toMatchObject({ status: 'ok', block: { name: 'tidy' } });
      expect(new Set(run.map((r) => r.operation_id)).size).toBe(1);
      type('/exit');
      await waitFor(/EXIT=0/);
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
    }
  }, 240_000);
});
