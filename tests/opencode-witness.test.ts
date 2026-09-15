// ORDER witness-o7c2 C1: an OpenCode plugin that seals intent before a tool runs and the result after it,
// injects the order into every shell, refuses any read of .env or the private overlay, and refuses outright
// outside an order. The hook contract is verified against @opencode-ai/plugin 1.18.31 — the exact version of
// the installed binary — whose Hooks keys are "tool.execute.before"(input{tool,sessionID,callID}, output{args}),
// "tool.execute.after"(input{tool,sessionID,callID,args}, output{title,output,metadata}) and
// "shell.env"(input{cwd,sessionID?,callID?}, output{env}).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ORDER = { id: 'witness-o7c2', head: 'deadbeefcafe1234' };
const IN_ORDER = { TIMMY_ORDER: ORDER.id, TIMMY_HEAD: ORDER.head };
const sha256Of = (s: string) => 'sha256_' + createHash('sha256').update(s).digest('hex');
const HEX64 = /^sha256_[0-9a-f]{64}$/;

type Sealed = { subject: string; input: Record<string, unknown> };

// the fake tool: hook inputs shaped exactly like OpenCode's, so the witness is tested against the real contract
const callBefore = (tool: string, args: unknown, callID = 'call_1') => ({
  input: { tool, sessionID: 'ses_1', callID },
  output: { args },
});
const callAfter = (tool: string, args: unknown, output: string, metadata: unknown = {}, callID = 'call_1') => ({
  input: { tool, sessionID: 'ses_1', callID, args },
  output: { title: tool, output, metadata },
});

async function load(env: Record<string, string | undefined>, sink?: 'fake' | 'chain') {
  const mod = await import('../packages/opencode-witness/src/witness.js');
  const sealed: Sealed[] = [];
  const deps: Record<string, unknown> = { env };
  if (sink !== 'chain') {
    deps.seal = (subject: string, input: Record<string, unknown>) => {
      sealed.push({ subject, input });
      return { id: 'rc_fake_1', hash: 'sha256_fake' };
    };
  }
  const hooks = mod.createWitness(deps as never);
  const need = <K extends string>(k: K) => {
    const h = (hooks as Record<string, unknown>)[k];
    if (typeof h !== 'function') throw new Error(`hook ${k} is missing`);
    return h as (input: never, output: never) => Promise<void>;
  };
  return { mod, sealed, need };
}

describe('witness-o7c2 C1 · tool.execute.before seals intent', () => {
  it('binds tool, args hash, order id and head hash', async () => {
    const { sealed, need } = await load(IN_ORDER, 'fake');
    const c = callBefore('read_file', { file_path: 'src/cli.ts', limit: 40 });
    await need('tool.execute.before')(c.input as never, c.output as never);
    expect(sealed).toHaveLength(1);
    expect(sealed[0].subject).toBe('witness.intent');
    const s = sealed[0].input;
    expect(s.tool).toBe('read_file');
    expect(s.order).toBe(ORDER.id);
    expect(s.head).toBe(ORDER.head);
    expect(s.callID).toBe('call_1');
    expect(String(s.args_sha256)).toMatch(HEX64);
  });

  it('hashes args canonically: key order cannot change the seal, different args must', async () => {
    const { sealed, need } = await load(IN_ORDER, 'fake');
    const hook = need('tool.execute.before');
    const a = callBefore('edit', { file_path: 'a.ts', old: 'x', new: 'y' });
    const b = callBefore('edit', { new: 'y', old: 'x', file_path: 'a.ts' });
    const c = callBefore('edit', { file_path: 'a.ts', old: 'x', new: 'CHANGED' });
    await hook(a.input as never, a.output as never);
    await hook(b.input as never, b.output as never);
    await hook(c.input as never, c.output as never);
    const [h1, h2, h3] = sealed.map((x) => x.input.args_sha256);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('never seals the argument values themselves — only their hash', async () => {
    const { sealed, need } = await load(IN_ORDER, 'fake');
    const secret = 'sk-super-secret-value';
    const c = callBefore('run_shell_command', { command: `echo ${secret}` });
    await need('tool.execute.before')(c.input as never, c.output as never);
    const body = JSON.stringify(sealed[0].input);
    expect(body).not.toContain(secret);
  });
});

describe('witness-o7c2 C1 · tool.execute.after seals the result', () => {
  it('binds the output hash and reports managed_output none when nothing was persisted', async () => {
    const { sealed, need } = await load(IN_ORDER, 'fake');
    const c = callAfter('read_file', { file_path: 'src/cli.ts' }, 'the tool output text');
    await need('tool.execute.after')(c.input as never, c.output as never);
    expect(sealed).toHaveLength(1);
    expect(sealed[0].subject).toBe('witness.result');
    const s = sealed[0].input;
    expect(s.output_sha256).toBe(sha256Of('the tool output text'));
    expect(s.managed_output).toBe('none');
    expect(s.order).toBe(ORDER.id);
  });

  it('binds a Managed Tool Output File by path, sha256 and size when the result references one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'witness-mof-'));
    try {
      const mof = join(dir, 'run_shell_command_abc123.output');
      const payload = 'x'.repeat(5000);
      writeFileSync(mof, payload);
      const { sealed, need } = await load(IN_ORDER, 'fake');
      const c = callAfter('run_shell_command', { command: 'make' }, 'truncated preview…', {
        managedOutputFile: mof,
      });
      await need('tool.execute.after')(c.input as never, c.output as never);
      const mo = sealed[0].input.managed_output as Record<string, unknown>;
      expect(mo.path).toBe(mof);
      expect(mo.sha256).toBe(sha256Of(payload));
      expect(mo.size).toBe(statSync(mof).size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not invent a managed file: a referenced path that does not exist is recorded as missing', async () => {
    const { sealed, need } = await load(IN_ORDER, 'fake');
    const ghost = join(tmpdir(), 'witness-ghost-does-not-exist.output');
    const c = callAfter('run_shell_command', { command: 'make' }, 'out', { managedOutputFile: ghost });
    await need('tool.execute.after')(c.input as never, c.output as never);
    const mo = sealed[0].input.managed_output as Record<string, unknown>;
    expect(mo).toMatchObject({ path: ghost, missing: true });
    expect(mo.sha256).toBeUndefined();
  });
});

describe('witness-o7c2 C1 · shell.env injects the order', () => {
  it('sets TIMMY_ORDER and TIMMY_HEAD and leaves the rest of the environment alone', async () => {
    const { need } = await load(IN_ORDER, 'fake');
    // deliberately not a path shape: the privacy gate flags /home/<name> and /Users/<name> literals,
    // and this test only asserts that pre-existing keys survive the injection.
    const output = { env: { PATH: '/usr/bin', HOME: 'preserved-home-value' } };
    await need('shell.env')({ cwd: '/repo', sessionID: 'ses_1' } as never, output as never);
    expect(output.env.TIMMY_ORDER).toBe(ORDER.id);
    expect(output.env.TIMMY_HEAD).toBe(ORDER.head);
    expect(output.env.PATH).toBe('/usr/bin');
    expect(output.env.HOME).toBe('preserved-home-value');
  });
});

describe('witness-o7c2 C1 · guarded paths throw', () => {
  it('refuses a read of .env: no intent seal, but the denial itself is sealed', async () => {
    const { sealed, need, mod } = await load(IN_ORDER, 'fake');
    const c = callBefore('read_file', { file_path: '/repo/.env' });
    await expect(need('tool.execute.before')(c.input as never, c.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    expect(sealed.filter((s) => s.subject === 'witness.intent')).toHaveLength(0);
    const denial = sealed.find((s) => s.subject === 'witness.denial');
    expect(denial).toBeTruthy();
    expect(denial?.input.reason).toBe('guarded_path');
    expect(denial?.input.guarded_id).toBe('dotenv');
    expect(JSON.stringify(denial?.input)).not.toContain('.env');
  });

  it('refuses a variant env file and a shell command that cats one', async () => {
    const { need, mod } = await load(IN_ORDER, 'fake');
    const a = callBefore('read_file', { file_path: '.env.local' });
    await expect(need('tool.execute.before')(a.input as never, a.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    const b = callBefore('run_shell_command', { command: 'cat .timmy/private/config.json' });
    await expect(need('tool.execute.before')(b.input as never, b.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
  });

  it('refuses the private overlay and the private receipt store', async () => {
    const { need, mod } = await load(IN_ORDER, 'fake');
    for (const p of ['.timmy/private/config.json', '.timmy/private/orders.log', 'lanes/privacy/overlay.mjs']) {
      const c = callBefore('read_file', { file_path: p });
      await expect(need('tool.execute.before')(c.input as never, c.output as never)).rejects.toBeInstanceOf(
        mod.WitnessRefusal
      );
    }
  });

  it('refuses a guarded path nested anywhere in the arguments', async () => {
    const { need, mod } = await load(IN_ORDER, 'fake');
    const c = callBefore('edit', { file_path: 'src/a.ts', context: { include: ['../../.env'] } });
    await expect(need('tool.execute.before')(c.input as never, c.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
  });

  it('seals the refusal itself, so a blocked call still leaves evidence', async () => {
    const { sealed, need } = await load(IN_ORDER, 'chain');
    const c = callBefore('read_file', { file_path: '.env' });
    await expect(need('tool.execute.before')(c.input as never, c.output as never)).rejects.toThrow();
    const { readChain } = await import('../src/utils/receipts.js');
    const chain = readChain('runs');
    const denials = chain.filter((r) => r.subject === 'witness.denial');
    expect(denials.length).toBeGreaterThanOrEqual(1);
    expect(denials[denials.length - 1].status).toBe('denied');
    expect(sealed).toHaveLength(0);
  });
});

describe('witness-o7c2 C1 · events append to runs.jsonl', () => {
  it('the default sink writes a hash-chained receipt into the runs stream', async () => {
    const { need } = await load(IN_ORDER, 'chain');
    const c = callBefore('glob', { pattern: 'src/**/*.ts' });
    await need('tool.execute.before')(c.input as never, c.output as never);
    const { readChain, receiptsPath } = await import('../src/utils/receipts.js');
    const chain = readChain('runs');
    const mine = chain.filter((r) => r.subject === 'witness.intent');
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe('seal');
    expect(mine[0].prev_hash).toBeTruthy();
    expect(mine[0].hash).toMatch(HEX64);
    expect(receiptsPath('runs')).toMatch(/runs\.jsonl$/);
    // runs.jsonl carries both receipts and bus events; the chain is exactly the id-bearing subset.
    const raw = readFileSync(receiptsPath('runs'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(raw.filter((r) => r.id).map((r) => r.id)).toEqual(chain.map((r) => r.id));
    expect(raw.some((r) => r.kind === 'receipt.sealed')).toBe(true);
  });
});

describe('witness-o7c2 C1 · outside an order everything is refused', () => {
  it('before, after and shell.env all refuse when no order is bound', async () => {
    const { sealed, need, mod } = await load({ TIMMY_ORDER: undefined, TIMMY_HEAD: undefined }, 'fake');
    const b = callBefore('read_file', { file_path: 'src/cli.ts' });
    await expect(need('tool.execute.before')(b.input as never, b.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    const a = callAfter('read_file', { file_path: 'src/cli.ts' }, 'out');
    await expect(need('tool.execute.after')(a.input as never, a.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    const output = { env: {} as Record<string, string> };
    await expect(need('shell.env')({ cwd: '/repo' } as never, output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    expect(output.env.TIMMY_ORDER).toBeUndefined();
    expect(sealed).toHaveLength(0);
  });

  it('a half-bound order (id without head) is refused too', async () => {
    const { need, mod } = await load({ TIMMY_ORDER: ORDER.id, TIMMY_HEAD: '' }, 'fake');
    const c = callBefore('read_file', { file_path: 'src/cli.ts' });
    await expect(need('tool.execute.before')(c.input as never, c.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
  });
});

describe('witness-o7c2 C1 · the module OpenCode loads', () => {
  it('exports a plugin function that returns the three hooks', async () => {
    const entry = await import('../packages/opencode-witness/src/index.js');
    expect(entry.id).toBe('timmy-opencode-witness');
    expect(typeof entry.TimmyOpenCodeWitness).toBe('function');
    const hooks = await entry.TimmyOpenCodeWitness({ directory: '/repo', worktree: '/repo' });
    for (const k of ['tool.execute.before', 'tool.execute.after', 'shell.env']) {
      expect(typeof (hooks as Record<string, unknown>)[k]).toBe('function');
    }
    expect(entry.default).toMatchObject({ id: 'timmy-opencode-witness' });
    expect(typeof entry.default.server).toBe('function');
  });
});
