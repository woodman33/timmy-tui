import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    const env = { ...process.env, HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, TIMMY_STORE: join(dir, 'store'), TIMMY_PALETTE: 'night', TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor', NODE_ENV: '' };
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
