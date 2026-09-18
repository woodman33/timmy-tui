// ORDER witness-o7c2 C1: an OpenCode plugin that seals intent before a tool runs and the result after it,
// injects the order into every shell, refuses any read of .env or the private overlay, and refuses outright
// outside an order. The hook contract is read from the INSTALLED @opencode-ai/plugin 1.4.7 (both
// ~/.opencode/node_modules and ~/.config/opencode/node_modules); the OpenCode CLI is 1.18.31 — the two
// versions are recorded separately and need not match. Its Hooks keys are
// "tool.execute.before"(input{tool,sessionID,callID}, output{args}),
// "tool.execute.after"(input{tool,sessionID,callID,args}, output{title,output,metadata}) and
// "shell.env"(input{cwd,sessionID?,callID?}, output{env}).
import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
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

async function load(
  env: Record<string, string | undefined>,
  sink?: 'fake' | 'chain',
  extra: Record<string, unknown> = {}
) {
  const mod = await import('../packages/opencode-witness/src/witness.js');
  const sealed: Sealed[] = [];
  const deps: Record<string, unknown> = { env, ...extra };
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

type Need = (k: string) => (input: never, output: never) => Promise<void>;

// An after-hook is only legal behind its matching before-hook, so every positive control seals the pair.
const sealPair = async (
  need: Need,
  tool: string,
  args: unknown,
  output: string,
  metadata: unknown = {},
  callID = 'call_1'
): Promise<void> => {
  const b = callBefore(tool, args, callID);
  await need('tool.execute.before')(b.input as never, b.output as never);
  const a = callAfter(tool, args, output, metadata, callID);
  await need('tool.execute.after')(a.input as never, a.output as never);
};

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
    const a = callBefore('edit', { file_path: 'a.ts', old: 'x', new: 'y' }, 'call_c1');
    const b = callBefore('edit', { new: 'y', old: 'x', file_path: 'a.ts' }, 'call_c2');
    const c = callBefore('edit', { file_path: 'a.ts', old: 'x', new: 'CHANGED' }, 'call_c3');
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
  const resultOf = (sealed: Sealed[]): Record<string, unknown> => {
    const r = sealed.find((s) => s.subject === 'witness.result');
    if (!r) throw new Error('no witness.result was sealed');
    return r.input;
  };

  it('binds the output hash and reports managed_output none when nothing was persisted', async () => {
    const { sealed, need } = await load(IN_ORDER, 'fake');
    await sealPair(need as Need, 'read_file', { file_path: 'src/cli.ts' }, 'the tool output text');
    expect(sealed.map((s) => s.subject)).toEqual(['witness.intent', 'witness.result']);
    const s = resultOf(sealed);
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
      const read: string[] = [];
      const sized: string[] = [];
      const { sealed, need } = await load(IN_ORDER, 'fake', {
        exists: (p: string) => p === mof,
        readFile: (p: string) => {
          read.push(p);
          return readFileSync(p, 'utf8');
        },
        sizeOf: (p: string) => {
          sized.push(p);
          return statSync(p).size;
        },
      });
      await sealPair(need as Need, 'run_shell_command', { command: 'make' }, 'truncated preview…', {
        managedOutputFile: mof,
      });
      const mo = resultOf(sealed).managed_output as Record<string, unknown>;
      expect(mo.path).toBe(mof);
      expect(mo.sha256).toBe(sha256Of(payload));
      expect(mo.size).toBe(statSync(mof).size);
      expect(read).toEqual([mof]); // a safe path is read exactly once
      expect(sized).toEqual([mof]); // and measured exactly once
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not invent a managed file: a referenced path that does not exist is recorded as missing', async () => {
    const { sealed, need } = await load(IN_ORDER, 'fake', { exists: () => false });
    const ghost = join(tmpdir(), 'witness-ghost-does-not-exist.output');
    await sealPair(need as Need, 'run_shell_command', { command: 'make' }, 'out', {
      managedOutputFile: ghost,
    });
    const mo = resultOf(sealed).managed_output as Record<string, unknown>;
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
    // Two rows are the expected shape for one seal: one hash-bearing receipt plus one receipt.sealed bus
    // notification. readChain selects hash-bearing rows — not merely rows that carry an id — so the
    // comparison is on hash, and the bus notification must point at that same receipt.
    const raw = readFileSync(receiptsPath('runs'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(raw).toHaveLength(2);
    const hashBearing = raw.filter((r) => typeof r.hash === 'string');
    expect(hashBearing).toHaveLength(1);
    expect(hashBearing.map((r) => r.hash)).toEqual(chain.map((r) => r.hash));
    const bus = raw.find((r) => r.kind === 'receipt.sealed');
    expect(bus).toBeTruthy();
    const payload = bus?.payload as Record<string, unknown>;
    expect(payload.id).toBe(mine[0].id);
    expect(payload.hash).toBe(mine[0].hash);
    expect(payload.subject).toBe('witness.intent');
    expect(payload.stream).toBe('runs');
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

describe('witness-o7c2 C1 · managed output cannot be redirected into a guarded path', () => {
  // Adversarial fs spies on synthetic paths: everything "exists", every read returns secret material,
  // every stat answers. If the witness touches a forbidden path at all — stat, read or measure — these
  // record it. No real secret is ever read.
  const spies = () => {
    const exists: string[] = [];
    const read: string[] = [];
    const sized: string[] = [];
    return {
      exists,
      read,
      sized,
      deps: {
        exists: (p: string) => {
          exists.push(p);
          return true;
        },
        readFile: (p: string) => {
          read.push(p);
          return 'SECRET-MATERIAL';
        },
        sizeOf: (p: string) => {
          sized.push(p);
          return 42;
        },
      },
    };
  };
  const body = (sealed: Sealed[]) => JSON.stringify(sealed.map((s) => s.input));

  it('refuses a metadata redirect into .env: never stat-ed, read or measured', async () => {
    const s = spies();
    const { sealed, need } = await load(IN_ORDER, 'fake', s.deps);
    await sealPair(need as Need, 'run_shell_command', { command: 'make' }, 'preview', {
      managedOutputFile: '/synthetic/project/.env',
    });
    expect(s.exists).toEqual([]);
    expect(s.read).toEqual([]);
    expect(s.sized).toEqual([]);
    expect(sealed.find((x) => x.subject === 'witness.result')?.input.managed_output).toMatchObject({
      refused: 'guarded_path',
      guarded_id: 'dotenv',
    });
    const denial = sealed.find((x) => x.subject === 'witness.denial');
    expect(denial?.input.reason).toBe('managed_output_redirect');
    expect(denial?.input.guarded_id).toBe('dotenv');
    expect(denial?.input.status).toBe('denied');
    expect(body(sealed)).not.toContain('.env');
    expect(body(sealed)).not.toContain('SECRET-MATERIAL');
  });

  it('refuses a metadata redirect into the private overlay', async () => {
    const s = spies();
    const { sealed, need } = await load(IN_ORDER, 'fake', s.deps);
    await sealPair(need as Need, 'read_file', { file_path: 'src/cli.ts' }, 'preview', {
      persistedOutput: '/synthetic/.timmy/private/config.json',
    });
    expect(s.exists).toEqual([]);
    expect(s.read).toEqual([]);
    expect(s.sized).toEqual([]);
    expect(sealed.find((x) => x.subject === 'witness.denial')?.input.guarded_id).toBe('private_overlay');
    expect(body(sealed)).not.toContain('SECRET-MATERIAL');
  });

  it('refuses a redirect carried in the output text instead of metadata', async () => {
    const s = spies();
    const { sealed, need } = await load(IN_ORDER, 'fake', s.deps);
    await sealPair(
      need as Need,
      'run_shell_command',
      { command: 'make' },
      'output saved to /synthetic/project/.env.output for later reading',
      {}
    );
    expect(s.exists).toEqual([]);
    expect(s.read).toEqual([]);
    expect(s.sized).toEqual([]);
    expect(sealed.find((x) => x.subject === 'witness.result')?.input.managed_output).toMatchObject({
      refused: 'guarded_path',
    });
    expect(sealed.find((x) => x.subject === 'witness.denial')?.input.reason).toBe(
      'managed_output_redirect'
    );
  });
});

describe('witness-o7c2 C1 · a result must present its matching intent', () => {
  const denialReason = (sealed: Sealed[]) => sealed.find((s) => s.subject === 'witness.denial')?.input.reason;
  const results = (sealed: Sealed[]) => sealed.filter((s) => s.subject === 'witness.result');

  it('refuses an orphan result and seals the refusal', async () => {
    const { sealed, need, mod } = await load(IN_ORDER, 'fake');
    const a = callAfter('read_file', { file_path: 'src/cli.ts' }, 'output text');
    await expect(need('tool.execute.after')(a.input as never, a.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    expect(results(sealed)).toHaveLength(0);
    expect(denialReason(sealed)).toBe('orphan_result');
    expect(sealed.find((s) => s.subject === 'witness.denial')?.input.status).toBe('denied');
  });

  it('refuses when the order id changed between the hooks, preserving the original intent seal', async () => {
    const env: Record<string, string | undefined> = { ...IN_ORDER };
    const { sealed, need, mod } = await load(env, 'fake');
    const b = callBefore('read_file', { file_path: 'src/cli.ts' }, 'call_x');
    await need('tool.execute.before')(b.input as never, b.output as never);
    env.TIMMY_ORDER = 'a-different-order'; // the context moves under the witness mid-call
    const a = callAfter('read_file', { file_path: 'src/cli.ts' }, 'out', {}, 'call_x');
    await expect(need('tool.execute.after')(a.input as never, a.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    expect(results(sealed)).toHaveLength(0);
    expect(denialReason(sealed)).toBe('context_changed');
    const intent = sealed.find((s) => s.subject === 'witness.intent');
    expect(intent?.input.order).toBe(ORDER.id); // preserved, never rebound
    expect(intent?.input.head).toBe(ORDER.head);
  });

  it('refuses when the head changed between the hooks', async () => {
    const env: Record<string, string | undefined> = { ...IN_ORDER };
    const { sealed, need, mod } = await load(env, 'fake');
    const b = callBefore('glob', { pattern: 'src/**' }, 'call_h');
    await need('tool.execute.before')(b.input as never, b.output as never);
    env.TIMMY_HEAD = 'ffffffffffffffff';
    const a = callAfter('glob', { pattern: 'src/**' }, 'out', {}, 'call_h');
    await expect(need('tool.execute.after')(a.input as never, a.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    expect(denialReason(sealed)).toBe('context_changed');
    expect(results(sealed)).toHaveLength(0);
  });

  it('refuses an after-hook naming a different tool than the intent', async () => {
    const { sealed, need, mod } = await load(IN_ORDER, 'fake');
    const b = callBefore('read_file', { file_path: 'src/cli.ts' }, 'call_t');
    await need('tool.execute.before')(b.input as never, b.output as never);
    const a = callAfter('run_shell_command', { file_path: 'src/cli.ts' }, 'out', {}, 'call_t');
    await expect(need('tool.execute.after')(a.input as never, a.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    expect(denialReason(sealed)).toBe('intent_mismatch');
    expect(results(sealed)).toHaveLength(0);
  });

  it('an intent is single-use: a replayed after-hook arrives as an orphan', async () => {
    const { sealed, need, mod } = await load(IN_ORDER, 'fake');
    await sealPair(need as Need, 'read_file', { file_path: 'src/cli.ts' }, 'first', {}, 'call_r');
    const again = callAfter('read_file', { file_path: 'src/cli.ts' }, 'replayed', {}, 'call_r');
    await expect(need('tool.execute.after')(again.input as never, again.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    expect(results(sealed)).toHaveLength(1);
    expect(denialReason(sealed)).toBe('orphan_result');
  });

  it('binds the intent linkage and flags argument drift instead of silently rebinding', async () => {
    const { sealed, need } = await load(IN_ORDER, 'fake');
    const b = callBefore('edit', { file_path: 'a.ts', old: 'x', new: 'y' }, 'call_d');
    await need('tool.execute.before')(b.input as never, b.output as never);
    const a = callAfter('edit', { file_path: 'a.ts', old: 'x', new: 'SUBSTITUTED' }, 'out', {}, 'call_d');
    await need('tool.execute.after')(a.input as never, a.output as never);
    const intent = sealed.find((s) => s.subject === 'witness.intent');
    const result = sealed.find((s) => s.subject === 'witness.result');
    expect(result?.input.args_sha256).toBe(intent?.input.args_sha256); // the intent stays the linkage
    expect(String(result?.input.args_drift)).toMatch(HEX64);
    expect(result?.input.args_drift).not.toBe(intent?.input.args_sha256);
    expect(result?.input.intent_receipt).toBe('rc_fake_1');
    expect(result?.input.intent_hash).toBe('sha256_fake');
    expect(result?.input.order).toBe(ORDER.id);
    expect(result?.input.head).toBe(ORDER.head);
    expect(JSON.stringify(result?.input)).not.toContain('SUBSTITUTED');
  });

  it('an unchanged call reports no drift and still carries the intent receipt', async () => {
    const { sealed, need } = await load(IN_ORDER, 'fake');
    await sealPair(need as Need, 'glob', { pattern: 'src/**/*.ts' }, 'ok', {}, 'call_ok');
    const result = sealed.find((s) => s.subject === 'witness.result');
    expect(result?.input.args_drift).toBe(false);
    expect(result?.input.intent_receipt).toBe('rc_fake_1');
    expect(result?.input.intent_hash).toBe('sha256_fake');
  });
});

describe('witness-o7c2 C1 · lexical aliases of a guarded path are refused', () => {
  it('normalizes lexically, without touching the filesystem', async () => {
    const { mod } = await load(IN_ORDER, 'fake');
    expect(mod.normalizePathish('/a/b/../c/./d')).toBe('/a/c/d');
    expect(mod.normalizePathish('/a//b///c/')).toBe('/a/b/c');
    expect(mod.normalizePathish('~/x/../.timmy/private/y')).toBe('~/.timmy/private/y');
    expect(mod.normalizePathish('/a/../../.env')).toBe('/.env');
    expect(mod.normalizePathish('make -j8')).toBe('make -j8'); // a non-path passes through harmless
  });

  it('refuses a traversal that hides the private overlay from a raw match', async () => {
    const { sealed, need, mod } = await load(IN_ORDER, 'fake');
    const sneaky = '/synthetic/.timmy/public/../private/config.json';
    expect(sneaky).not.toMatch(/\.timmy[/\\]private([/\\]|$)/i); // the raw form genuinely evades
    const c = callBefore('read_file', { file_path: sneaky });
    await expect(need('tool.execute.before')(c.input as never, c.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    expect(sealed.find((s) => s.subject === 'witness.denial')?.input.guarded_id).toBe('private_overlay');
    expect(sealed.filter((s) => s.subject === 'witness.intent')).toHaveLength(0);
  });

  it('refuses ~ plus traversal into the private ledger', async () => {
    const { sealed, need, mod } = await load(IN_ORDER, 'fake');
    const sneaky = '~/work/.timmy/public/../private/orders.log';
    expect(sneaky).not.toMatch(/\.timmy[/\\]private([/\\]|$)/i);
    const c = callBefore('read_file', { file_path: sneaky });
    await expect(need('tool.execute.before')(c.input as never, c.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    expect(sealed.find((s) => s.subject === 'witness.denial')?.input.guarded_id).toBe('private_overlay');
  });

  it('refuses case aliases, because the host filesystem is case-insensitive', async () => {
    const { sealed, need, mod } = await load(IN_ORDER, 'fake');
    for (const p of ['/synthetic/project/.ENV', '/synthetic/project/.Env.Local']) {
      const c = callBefore('read_file', { file_path: p });
      await expect(need('tool.execute.before')(c.input as never, c.output as never)).rejects.toBeInstanceOf(
        mod.WitnessRefusal
      );
    }
    expect(sealed.filter((s) => s.subject === 'witness.denial')).toHaveLength(2);
    expect(sealed.find((s) => s.subject === 'witness.denial')?.input.guarded_id).toBe('dotenv');
    expect(sealed.filter((s) => s.subject === 'witness.intent')).toHaveLength(0);
  });
});

describe('witness-o7c2 C1 · symlink aliases cannot reach protected content', () => {
  // Real synthetic temporary files, and spies on every fs call the witness could make. The presented name
  // carries no guarded token, so only alias resolution can catch it.
  const fsSpies = () => {
    const ex: string[] = [];
    const read: string[] = [];
    const sized: string[] = [];
    return {
      ex,
      read,
      sized,
      deps: {
        exists: (p: string) => {
          ex.push(p);
          return existsSync(p);
        },
        readFile: (p: string) => {
          read.push(p);
          return readFileSync(p, 'utf8');
        },
        sizeOf: (p: string) => {
          sized.push(p);
          return statSync(p).size;
        },
      },
    };
  };

  it('refuses a symlink to .env: never stat-ed, read, measured or hashed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'witness-alias-file-'));
    try {
      const envFile = join(dir, '.env');
      writeFileSync(envFile, 'SECRET-MATERIAL');
      const link = join(dir, 'innocent.output'); // no guarded token in the presented name
      symlinkSync(envFile, link);
      expect(link).not.toMatch(/(^|[/\s'"])\.env(\.[A-Za-z0-9_.-]+)?($|[/\s'"])/i);
      const s = fsSpies();
      const { sealed, need } = await load(IN_ORDER, 'fake', s.deps);
      await sealPair(need as Need, 'run_shell_command', { command: 'make' }, 'preview', {
        managedOutputFile: link,
      });
      expect(s.ex).toEqual([]);
      expect(s.read).toEqual([]);
      expect(s.sized).toEqual([]);
      const mo = sealed.find((x) => x.subject === 'witness.result')?.input
        .managed_output as Record<string, unknown>;
      expect(mo.refused).toBe('guarded_path');
      expect(mo.guarded_id).toBe('dotenv');
      expect(mo.sha256).toBeUndefined();
      expect(mo.size).toBeUndefined();
      const body = JSON.stringify(sealed.map((x) => x.input));
      expect(body).not.toContain('SECRET-MATERIAL');
      expect(body).not.toContain(sha256Of('SECRET-MATERIAL')); // the content was never hashed either
      expect(sealed.find((x) => x.subject === 'witness.denial')?.input.reason).toBe(
        'managed_output_redirect'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked directory that aliases the private overlay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'witness-alias-dir-'));
    try {
      mkdirSync(join(dir, '.timmy', 'private'), { recursive: true });
      writeFileSync(join(dir, '.timmy', 'private', 'config.json'), 'SECRET-MATERIAL');
      const logs = join(dir, 'logs');
      symlinkSync(join(dir, '.timmy', 'private'), logs);
      const candidate = join(logs, 'config.json');
      expect(candidate).not.toMatch(/\.timmy[/\\]private([/\\]|$)/i);
      const s = fsSpies();
      const { sealed, need } = await load(IN_ORDER, 'fake', s.deps);
      await sealPair(need as Need, 'read_file', { file_path: 'src/cli.ts' }, 'preview', {
        persistedOutput: candidate,
      });
      expect(s.read).toEqual([]);
      expect(s.sized).toEqual([]);
      expect(sealed.find((x) => x.subject === 'witness.result')?.input.managed_output).toMatchObject({
        refused: 'guarded_path',
        guarded_id: 'private_overlay',
      });
      expect(JSON.stringify(sealed.map((x) => x.input))).not.toContain('SECRET-MATERIAL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still binds a safe symlink target, and the permitted path stays visible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'witness-alias-ok-'));
    try {
      const real = join(dir, 'real.output');
      writeFileSync(real, 'safe-content');
      const link = join(dir, 'alias.output');
      symlinkSync(real, link);
      const { sealed, need } = await load(IN_ORDER, 'fake');
      await sealPair(need as Need, 'run_shell_command', { command: 'make' }, 'preview', {
        managedOutputFile: link,
      });
      const mo = sealed.find((x) => x.subject === 'witness.result')?.input
        .managed_output as Record<string, unknown>;
      expect(mo.refused).toBeUndefined();
      expect(mo.path).toBe(link); // permitted paths are bound literally, not hashed
      expect(mo.realpath).toBe(realpathSync(link));
      expect(mo.sha256).toBe(sha256Of('safe-content'));
      expect(mo.size).toBe(12);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('witness-o7c2 C1 · session/call identity and duplicate intents', () => {
  const intents = (sealed: Sealed[]) => sealed.filter((s) => s.subject === 'witness.intent');
  const results = (sealed: Sealed[]) => sealed.filter((s) => s.subject === 'witness.result');
  const denial = (sealed: Sealed[]) => sealed.find((s) => s.subject === 'witness.denial');

  it('defines identity as the (sessionID, callID) pair, injectively', async () => {
    const { mod } = await load(IN_ORDER, 'fake');
    expect(mod.intentKey('ses_A', 'call_1')).toBe(mod.intentKey('ses_A', 'call_1'));
    expect(mod.intentKey('ses_A', 'call_1')).not.toBe(mod.intentKey('ses_B', 'call_1'));
    expect(mod.intentKey('ses_A', 'call_1')).not.toBe(mod.intentKey('ses_A|call', '1')); // no forged separator
  });

  it('refuses a duplicate pending intent before sealing a replacement, and preserves the original', async () => {
    const { sealed, need, mod } = await load(IN_ORDER, 'fake');
    const first = callBefore('read_file', { file_path: 'src/cli.ts' }, 'call_dup');
    await need('tool.execute.before')(first.input as never, first.output as never);
    const second = callBefore('read_file', { file_path: 'DIFFERENT-ARGS' }, 'call_dup');
    await expect(
      need('tool.execute.before')(second.input as never, second.output as never)
    ).rejects.toBeInstanceOf(mod.WitnessRefusal);
    expect(intents(sealed)).toHaveLength(1); // no replacement was sealed, nothing overwritten
    expect(denial(sealed)?.input.reason).toBe('duplicate_intent');
    expect(denial(sealed)?.input.status).toBe('denied');
    expect(denial(sealed)?.input.existing_intent_receipt).toBe('rc_fake_1');
    expect(JSON.stringify(denial(sealed)?.input)).not.toContain('DIFFERENT-ARGS');
    // the original intent still binds its own result
    const a = callAfter('read_file', { file_path: 'src/cli.ts' }, 'out', {}, 'call_dup');
    await need('tool.execute.after')(a.input as never, a.output as never);
    expect(results(sealed)).toHaveLength(1);
    expect(results(sealed)[0].input.args_sha256).toBe(intents(sealed)[0].input.args_sha256);
  });

  it('treats the same callID in another session as a different identity, and binds each after-hook correctly', async () => {
    const { sealed, need } = await load(IN_ORDER, 'fake');
    const bA = { input: { tool: 'glob', sessionID: 'ses_A', callID: 'call_1' }, output: { args: { pattern: 'a' } } };
    const bB = { input: { tool: 'glob', sessionID: 'ses_B', callID: 'call_1' }, output: { args: { pattern: 'b' } } };
    await need('tool.execute.before')(bA.input as never, bA.output as never);
    await need('tool.execute.before')(bB.input as never, bB.output as never);
    expect(intents(sealed)).toHaveLength(2); // same callID, different session: no collision, no refusal
    const aB = {
      input: { tool: 'glob', sessionID: 'ses_B', callID: 'call_1', args: { pattern: 'b' } },
      output: { title: 'glob', output: 'ok', metadata: {} },
    };
    await need('tool.execute.after')(aB.input as never, aB.output as never);
    expect(results(sealed)).toHaveLength(1);
    expect(results(sealed)[0].input.sessionID).toBe('ses_B');
    expect(results(sealed)[0].input.args_sha256).toBe(intents(sealed)[1].input.args_sha256);
    // ses_A's intent is untouched and still binds its own result
    const aA = {
      input: { tool: 'glob', sessionID: 'ses_A', callID: 'call_1', args: { pattern: 'a' } },
      output: { title: 'glob', output: 'ok2', metadata: {} },
    };
    await need('tool.execute.after')(aA.input as never, aA.output as never);
    expect(results(sealed)).toHaveLength(2);
    expect(results(sealed)[1].input.sessionID).toBe('ses_A');
    expect(results(sealed)[1].input.args_sha256).toBe(intents(sealed)[0].input.args_sha256);
  });

  it('an after-hook from a third session with the same callID is an orphan, not a rebind', async () => {
    const { sealed, need, mod } = await load(IN_ORDER, 'fake');
    const b = { input: { tool: 'glob', sessionID: 'ses_A', callID: 'call_1' }, output: { args: { pattern: 'a' } } };
    await need('tool.execute.before')(b.input as never, b.output as never);
    const a = {
      input: { tool: 'glob', sessionID: 'ses_C', callID: 'call_1', args: { pattern: 'a' } },
      output: { title: 'glob', output: 'ok', metadata: {} },
    };
    await expect(need('tool.execute.after')(a.input as never, a.output as never)).rejects.toBeInstanceOf(
      mod.WitnessRefusal
    );
    expect(results(sealed)).toHaveLength(0);
    expect(denial(sealed)?.input.reason).toBe('orphan_result');
    expect(intents(sealed)).toHaveLength(1); // the pending intent survives the refused orphan
  });
});
