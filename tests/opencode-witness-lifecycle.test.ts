// Synthetic hook lifecycle controls only: no OpenCode runtime, providers, or
// shared receipt store. Rejected seal promises may have committed already.
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWitness, argsHash, WitnessRefusal, type SealResult, type SealSink } from '../packages/opencode-witness/src/witness.js';

const env = { TIMMY_ORDER: 'synthetic-lifecycle', TIMMY_HEAD: 'synthetic-revision' };
const input = { tool: 'read_file', sessionID: 'synthetic-session', callID: 'call-1' };
const args = { file_path: 'src/synthetic.ts' };
const afterInput = { ...input, args };
const output = { title: 'synthetic', output: 'observed text', metadata: {} };
type Event = { subject: string; body: Record<string, unknown> };
const receipt = (n: number): SealResult => ({ id: `synthetic-${n}`, hash: `synthetic-hash-${n}` });
const matching = (events: Event[], subject: string) => events.filter(event => event.subject === subject);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function sink(events: Event[]): SealSink {
  return (subject, body) => { events.push({ subject, body }); return receipt(events.length); };
}

// An uncertain commit must never look like a missing/orphan intent: that loses
// the distinction needed to reconcile rather than rerun a native operation.
async function expectRetainedRefusal(action: Promise<void>) {
  const outcome = await action.then(() => null, error => error);
  expect(outcome).toBeInstanceOf(WitnessRefusal);
  expect(outcome.reason).toBe('seal_uncertain');
}

describe('OpenCode witness synthetic lifecycle', () => {
  it('binds UTF-8 byte length to the exact bytes hashed for Unicode output', async () => {
    const events: Event[] = [];
    const hooks = createWitness({ env, seal: sink(events) });
    const text = 'café 🎬 漢字';
    await hooks['tool.execute.before'](input, { args });
    await hooks['tool.execute.after'](afterInput, { ...output, output: text });
    const result = matching(events, 'witness.result')[0].body;
    expect(result.output_bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(result.output_sha256).toBe('sha256_' + createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
  });

  it('retains the original intent when managed-output read fails before any result seal attempt', async () => {
    const events: Event[] = [];
    let readable = false;
    const hooks = createWitness({ env, seal: sink(events), exists: () => true,
      sizeOf: () => 4,
      readFile: () => { if (!readable) throw new Error('synthetic read failure'); return 'safe'; } });
    const dir = mkdtempSync(join(tmpdir(), 'witness-lifecycle-'));
    const path = join(dir, 'tool.output');
    writeFileSync(path, 'safe');
    const managed = { ...output, metadata: { managedOutputFile: path } };
    try {
    await hooks['tool.execute.before'](input, { args });
    await expect(hooks['tool.execute.after'](afterInput, managed)).rejects.toThrow();
    expect(matching(events, 'witness.result')).toHaveLength(0);
    readable = true;
    await hooks['tool.execute.after'](afterInput, managed);
    expect(matching(events, 'witness.intent')).toHaveLength(1);
    expect(matching(events, 'witness.result')).toHaveLength(1);
    expect(matching(events, 'witness.result')[0].body.intent_receipt).toBe('synthetic-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reserves a call identity before awaiting the intent seal', async () => {
    const events: Event[] = [];
    const pendingSeal = deferred<SealResult>();
    const hooks = createWitness({ env, seal: (subject, body) => {
      events.push({ subject, body });
      return subject === 'witness.intent' ? pendingSeal.promise : receipt(events.length);
    } });
    const first = hooks['tool.execute.before'](input, { args });
    const second = hooks['tool.execute.before'](input, { args: { file_path: 'src/replacement.ts' } });
    const settled = Promise.allSettled([first, second]);
    pendingSeal.resolve(receipt(1));
    const outcomes = await settled;
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(matching(events, 'witness.intent')).toHaveLength(1);
    await hooks['tool.execute.after'](afterInput, output);
    expect(matching(events, 'witness.result')).toHaveLength(1);
    expect(matching(events, 'witness.result')[0].body.args_drift).toBe(false);
  });

  it('permits only one result seal while its promise is pending', async () => {
    const events: Event[] = [];
    const pendingSeal = deferred<SealResult>();
    const hooks = createWitness({ env, seal: (subject, body) => {
      events.push({ subject, body });
      return subject === 'witness.result' ? pendingSeal.promise : receipt(events.length);
    } });
    await hooks['tool.execute.before'](input, { args });
    const first = hooks['tool.execute.after'](afterInput, output);
    const second = hooks['tool.execute.after'](afterInput, output);
    const replacement = hooks['tool.execute.before'](input, { args });
    const settled = Promise.allSettled([first, second, replacement]);
    pendingSeal.resolve(receipt(2));
    const outcomes = await settled;
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(matching(events, 'witness.result')).toHaveLength(1);
    expect(matching(events, 'witness.intent')).toHaveLength(1);
  });

  it('does not blindly repeat a result seal that may have committed before throwing', async () => {
    const events: Event[] = [];
    const hooks = createWitness({ env, seal: (subject, body) => {
      events.push({ subject, body }); // fake commit precedes transport failure
      if (subject === 'witness.result') throw new Error('synthetic acknowledgement lost');
      return receipt(events.length);
    } });
    await hooks['tool.execute.before'](input, { args });
    await expect(hooks['tool.execute.after'](afterInput, output)).rejects.toThrow();
    await expectRetainedRefusal(hooks['tool.execute.after'](afterInput, output));
    await expect(hooks['tool.execute.before'](input, { args })).rejects.toBeInstanceOf(WitnessRefusal);
    expect(matching(events, 'witness.intent')).toHaveLength(1);
    expect(matching(events, 'witness.result')).toHaveLength(1);
  });

  it('holds an uncertain intent identity without blocking unrelated calls', async () => {
    const events: Event[] = [];
    const hooks = createWitness({ env, seal: (subject, body) => {
      events.push({ subject, body }); // fake commit precedes rejected promise
      if (subject === 'witness.intent' && body.callID === input.callID) {
        return Promise.reject(new Error('synthetic acknowledgement lost'));
      }
      return receipt(events.length);
    } });
    await expect(hooks['tool.execute.before'](input, { args })).rejects.toThrow();
    await expect(hooks['tool.execute.before'](input, { args })).rejects.toBeInstanceOf(WitnessRefusal);
    await expectRetainedRefusal(hooks['tool.execute.after'](afterInput, output));
    expect(matching(events, 'witness.intent')).toHaveLength(1);
    expect(matching(events, 'witness.result')).toHaveLength(0);
    const other = { ...input, callID: 'independent-call' };
    await hooks['tool.execute.before'](other, { args });
    await hooks['tool.execute.after']({ ...other, args }, output);
    expect(matching(events, 'witness.result')).toHaveLength(1);
  });
});


describe('witness argument identity is complete finite JSON', () => {
  it('does not omit an own __proto__ data property from the argument hash', () => {
    const special = JSON.parse('{"__proto__":{"synthetic":"value"}}');
    expect(argsHash(special)).not.toBe(argsHash({}));
    expect(argsHash({ nested: special })).not.toBe(argsHash({ nested: {} }));
  });

  it.each([NaN, Infinity, -Infinity])('refuses a nonfinite JSON value: %s', number => {
    expect(() => argsHash({ nested: [number] })).toThrow();
  });

  it('refuses cyclic arguments without sealing an intent', async () => {
    const events: Event[] = [];
    const hooks = createWitness({ env, seal: sink(events) });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(hooks['tool.execute.before'](input, { args: cycle })).rejects.toBeInstanceOf(WitnessRefusal);
    expect(matching(events, 'witness.intent')).toHaveLength(0);
  });
});
