import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/repl/commands.js';
import { measureTerminal, parseReplArgs, replHelp } from '../src/repl/main.js';

describe('timmy repl flags', () => {
  it('reads --demo, --demo-loader, --plain, --color and --no-color', () => {
    expect(parseReplArgs(['--demo'])).toEqual({ demo: true });
    expect(parseReplArgs(['--demo-loader', '--plain'])).toEqual({ demoLoader: true, plain: true });
    expect(parseReplArgs(['--no-color'])).toEqual({ color: false });
    expect(parseReplArgs(['--color'])).toEqual({ color: true });
  });
  it('names an unknown flag (usage error, exit 2)', () => {
    expect(parseReplArgs(['--dmeo'])).toEqual({ error: 'Unknown option: --dmeo. Did you mean --demo?' });
  });
});

describe('measureTerminal', () => {
  it('trusts TIMMY_PALETTE and asks the terminal nothing', async () => {
    const io = { stdin: { isTTY: true }, stdout: { isTTY: true, write: () => { throw new Error('queried'); } } };
    const m = await measureTerminal({ interactive: true }, { TIMMY_PALETTE: 'day' }, io as never);
    expect(m.background).toBe('#FFFFFF');
    expect(m.slots[8]).toBe('#595959');
  });
  it('waits longer for the answer over SSH, so a late reply never lands in the prompt', async () => {
    const waited: number[] = [];
    const probe = async (_io: unknown, _caps: unknown, ms?: number) => { waited.push(ms ?? -1); return { background: null, slots: {} }; };
    const io = { stdin: { isTTY: false }, stdout: { isTTY: false } } as never;
    await measureTerminal({ interactive: true, ssh: true }, {}, io, probe as never);
    await measureTerminal({ interactive: true, ssh: false }, {}, io, probe as never);
    expect(waited).toEqual([1000, 200]);
  });
});

describe('timmy repl --help', () => {
  it('reads -h and --help', () => {
    expect(parseReplArgs(['--help'])).toEqual({ help: true });
    expect(parseReplArgs(['-h'])).toEqual({ help: true });
  });
  it('is generated from the same registries as the flags and /help', () => {
    const help = replHelp();
    for (const flag of ['--demo', '--demo-loader', '--plain', '--color', '--no-color', '--help']) expect(help).toContain(flag);
    for (const c of COMMANDS) expect(help).toContain(`/${c.name}`);
    expect(help.startsWith('timmy repl: ')).toBe(true);
    expect(help).toContain('USAGE');
    expect(help).not.toMatch(/\x1b\[/);
  });
});

