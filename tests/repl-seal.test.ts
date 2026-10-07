import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withoutCI } from './fixtures/repl-pty-env.js';
import { sealTurn } from '../src/repl/seal.js';
import { readChain, receiptsPath } from '../src/utils/receipts.js';

// C-8: every finished REPL turn is sealed through appendReceipt (AGENTS.md §6). Nothing raw is sealed:
// the prompt and the answer go in as hashes. Verified means the chain verifies after the write and
// the receipt's own ed25519 signature checks out; anything else is broken (✖), never green.
const dirs: string[] = [];
const store = (): string => { const d = mkdtempSync(join(tmpdir(), 'timmy-seal-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const facts = { prompt: 'the secret plan', answer: 'the secret answer', steps: 2, spend: 0.004, ms: 1500, status: 'ok' as const, model: 'anthropic/claude-sonnet-4.5' };

describe('sealTurn', () => {
  it('seals the turn with hashes only, signed, and verifies it', () => {
    const dir = store();
    const s = sealTurn(facts, dir);
    const chain = readChain('runs', dir);
    expect(chain.map((r) => [r.kind, r.status, r.prompt_hash, r.response_hash, r.model_requested])).toEqual([['turn', 'ok', sha(facts.prompt), sha(facts.answer), facts.model]]);
    expect(readFileSync(receiptsPath('runs', dir), 'utf8')).not.toContain('secret');
    expect({ id: s.id, hash: s.hash, verified: s.verified }).toEqual({ id: chain[0].hash.slice(7, 15), hash: chain[0].hash, verified: true });
  });
  it('a chain broken before the turn makes the receipt broken, never verified', () => {
    const dir = store();
    sealTurn(facts, dir);
    const p = receiptsPath('runs', dir);
    writeFileSync(p, readFileSync(p, 'utf8').replace('"steps', '"stepz').replace('repl', 'REPL'));
    expect(sealTurn({ ...facts, status: 'failed' }, dir).verified).toBe('broken');
  });
});

// In a real PTY: one turn through the real REPL loop and the real sealer. The line is green after the
// verify, and the store holds that one receipt.
describe('a turn in the REPL', () => {
  it('closes with ✓ RECEIPT, signed and verified, and the store holds it', async () => {
    const dir = store();
    const env = { ...withoutCI(process.env), HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, TIMMY_STORE: join(dir, 'store'), TIMMY_PALETTE: 'night', TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor', NODE_ENV: '' };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'seal', ...args], { env, encoding: 'utf8' });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '30', '-c', dir, 'bash', '--norc', '-c', `${resolve('node_modules/.bin/tsx')} ${resolve('tests/fixtures/repl-seal-fixture.ts')}; echo EXIT=$?; sleep 60`);
      const screen = () => tmux('capture-pane', '-p', '-t', 't');
      const waitFor = async (re: RegExp) => {
        for (let i = 0; i < 300; i++) { if (re.test(screen())) return; await sleep(50); }
        throw new Error(`timed out waiting for ${re}:\n${screen()}`);
      };
      await waitFor(/Enter to send/);
      tmux('send-keys', '-t', 't', '-l', 'what time is it');
      tmux('send-keys', '-t', 't', 'Enter');
      await waitFor(/RECEIPT [0-9a-f]{8} signed and verified/);
      const id = screen().match(/✓ RECEIPT ([0-9a-f]{8}) signed and verified/)?.[1];
      const chain = readFileSync(join(dir, 'store', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => typeof r.prev_hash === 'string');
      expect(chain.map((r) => [r.kind, r.status, r.hash.slice(7, 15)])).toEqual([['turn', 'ok', id]]);
      expect(screen()).toMatch(/1 step · \$0\.000 · [0-9.]+s/);
      tmux('send-keys', '-t', 't', '-l', '/exit');
      tmux('send-keys', '-t', 't', 'Enter');
      await waitFor(/EXIT=0/);
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
    }
  }, 60_000);
});

// Third order, checkpoint 1: a cancelled turn goes through the same writer, with what its tools did.
describe('sealTurn for a cancelled turn', () => {
  it('seals status cancelled, each tool\'s outcome, where the cancel came, and no rollback; verified', () => {
    const dir = store();
    const s = sealTurn({ ...facts, answer: '', status: 'cancelled', tools: [{ tool: 'file_read', outcome: 'completed' }, { tool: 'shell', outcome: 'unknown' }], cancelledAt: 'during-tool' }, dir);
    const [r] = readChain('runs', dir);
    expect({ status: r.status, tools: r.tool_outcomes, at: r.cancelled_at, rollback: r.rollback, subject: r.subject, verified: s.verified }).toEqual({
      status: 'cancelled',
      tools: [{ name: 'file_read', outcome: 'completed' }, { name: 'shell', outcome: 'unknown' }],
      at: 'during-tool',
      rollback: 'none',
      subject: 'repl · cancelled · 2 steps',
      verified: true,
    });
  });
});

// Third order, checkpoint 1, in a real PTY with the normal writer and an isolated store: Ctrl+C while a
// tool runs seals the cancelled turn with that tool's outcome unknown; and when the stream ignores the
// cancel, the second Ctrl+C still seals the turn before it quits (130).
describe('a cancelled turn in the REPL', () => {
  const FIXTURE = resolve('tests/fixtures/repl-qualify-fixture.ts');
  const LOADER = `file://${resolve('node_modules/tsx/dist/loader.mjs')}`;
  const run = async (stuck: boolean) => {
    const dir = store();
    const env = { ...withoutCI(process.env), HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, TIMMY_STORE: join(dir, 'store'), TIMMY_PALETTE: 'night', TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor', NODE_ENV: '', TIMMY_Q_SCRIPT: 'slowtool', TIMMY_Q_SEAL: '1', TIMMY_Q_STUCK: stuck ? '1' : '' };
    const sock = stuck ? 'cstuck' : 'cancel';
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', sock, ...args], { env, encoding: 'utf8' });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (re: RegExp) => { for (let i = 0; i < 200; i++) { const s = tmux('capture-pane', '-p', '-J', '-S', '-', '-t', 'c'); if (re.test(s)) return s; await sleep(50); } throw new Error(`timed out waiting for ${re}`); };
    try {
      tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'c', '-x', '100', '-y', '30', '-c', dir, 'bash', '--norc', '-c', `${process.execPath} --import ${LOADER} ${FIXTURE}; echo EXIT=$?; sleep 60`);
      await waitFor(/Enter to send/);
      await sleep(400);
      tmux('send-keys', '-t', 'c', '-l', 'render the storyboard');
      tmux('send-keys', '-t', 'c', 'Enter');
      await waitFor(/npm run render:storyboard/);
      await sleep(500);
      tmux('send-keys', '-t', 'c', 'C-c');
      if (stuck) { await waitFor(/Press Ctrl\+C again to quit/); tmux('send-keys', '-t', 'c', 'C-c'); }
      const screen = await waitFor(stuck ? /EXIT=\d+/ : /cancelled\n[\s\S]*Enter to send/);
      // TIMMY_STORE is the receipts folder itself; the bus shares runs.jsonl, so receipts are the lines with prev_hash.
      const p = join(dir, 'store', 'runs.jsonl');
      const chain = existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => typeof r.prev_hash === 'string') : [];
      return { screen, chain };
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
    }
  };
  it('Ctrl+C while the tool runs: the receipt has the tool\'s outcome unknown, and says nothing was rolled back', async () => {
    const { screen, chain } = await run(false);
    expect(screen).toContain('Cancelled. shell was running: outcome unknown. Nothing was rolled back.');
    expect(screen).toMatch(/✓ RECEIPT [0-9a-f]{8} signed and verified/);
    expect(chain.map((r) => [r.status, r.cancelled_at, r.rollback, r.tool_outcomes])).toEqual([['cancelled', 'during-tool', 'none', [{ name: 'shell', outcome: 'unknown' }]]]);
  }, 30_000);
  it('a stream that ignores the cancel: the second Ctrl+C seals the turn, then quits with 130', async () => {
    const { screen, chain } = await run(true);
    expect(screen).toMatch(/EXIT=130/);
    expect(chain.map((r) => [r.status, r.cancelled_at, r.tool_outcomes])).toEqual([['cancelled', 'during-tool', [{ name: 'shell', outcome: 'unknown' }]]]);
  }, 30_000);
});
