import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { leakCheck, parseRounds } from '../src/harness/cockpit.js';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync), lstatSync: vi.fn(fs.lstatSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const fixtures: string[] = [];
afterEach(() => {
  vi.mocked(readdirSync).mockReset().mockImplementation(actualFs.readdirSync);
  vi.mocked(lstatSync).mockReset().mockImplementation(actualFs.lstatSync);
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-artifacts-'));
  fixtures.push(dir);
  for (const file of files) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'synthetic fixture\n');
  }
  return dir;
}

const sourceFiles = [
  'lanes/cockpit/README.md',
  'lanes/cockpit/cockpit.mjs',
  'lanes/cockpit/hands.example.json',
  'src/harness/cockpit.ts',
];

describe('cockpit prompt dictionary', () => {
  it.each(['__proto__', 'constructor', 'toString'])('keeps %s as an own hand name without changing inherited objects', name => {
    // Restore the inherited object if this regression is run against the old parser.
    const inherited = ({} as Record<string, object>)[name];
    const before = Object.getOwnPropertyDescriptor(inherited, 'R0');
    try {
      const { prompts } = parseRounds(`## prompt ${name} R0\nsynthetic prompt\n`);
      expect(Object.getOwnPropertyDescriptor(inherited, 'R0')).toEqual(before);
      expect(Object.hasOwn(prompts, name)).toBe(true);
      expect(Object.getPrototypeOf(prompts)).toBeNull();
      expect(Object.getPrototypeOf(prompts[name])).toBeNull();
      expect(prompts[name].R0).toBe('synthetic prompt');
      const stored = JSON.parse(JSON.stringify(prompts));
      expect(Object.hasOwn(stored, name)).toBe(true);
      expect(stored[name].R0).toBe('synthetic prompt');
    } finally {
      if (before) Object.defineProperty(inherited, 'R0', before);
      else Reflect.deleteProperty(inherited, 'R0');
    }
  });

  it('retains multiple rounds for ordinary hand names', () => {
    const { prompts } = parseRounds('## prompt worker R0\nfirst\n## prompt worker R1\nsecond\n');
    expect(JSON.parse(JSON.stringify(prompts))).toEqual({ worker: { R0: 'first', R1: 'second' } });
  });
});

describe('cockpit release artifact check', () => {
  it('keeps application source, documentation, and the public registry example', () => {
    expect(leakCheck(tree(sourceFiles))).toEqual([]);
  });

  it('still refuses runtime payloads next to legitimate source and in other cockpit subtrees', () => {
    const payloads = [
      'lanes/cockpit/hands.json',
      'lanes/cockpit/session.json',
      'lanes/cockpit/prompts.json',
      'lanes/cockpit/worker/2026-01-01.log',
      'docs/cockpit/transcript.json',
      'docs/cockpit/transcript.txt',
      'docs/cockpit/transcript.md',
      'docs/cockpit/transcript.jsonl',
      'docs/cockpit/events.ndjson',
      'docs/cockpit/recording.cast',
      'docs/cockpit/recording.asciicast',
      'lanes/cockpit/unexpected-payload.bin',
      'docs/cockpit/README.md',
      'other/cockpit/hands.example.json',
    ];
    expect(leakCheck(tree([...sourceFiles, ...payloads]))).toEqual(payloads.sort());
  });

  it('refuses a missing scan root', () => {
    const dir = tree([]);
    expect(leakCheck(join(dir, 'missing'))).toEqual(['scan incomplete: . (cannot read directory)']);
  });

  it('refuses a scan root that is a file', () => {
    const dir = tree(['README.md']);
    expect(leakCheck(join(dir, 'README.md'))).toEqual(['scan incomplete: . (cannot read directory)']);
  });

  it('refuses an unreadable root without exposing the raw filesystem error', () => {
    const dir = tree([]);
    vi.mocked(readdirSync).mockImplementationOnce(() => {
      throw new Error(`synthetic private filesystem detail: ${dir}`);
    });
    expect(leakCheck(dir)).toEqual(['scan incomplete: . (cannot read directory)']);
  });

  it('reports an unreadable subtree and retains known leaks from its siblings', () => {
    const dir = tree(['board.json', 'docs/README.md']);
    vi.mocked(readdirSync)
      .mockImplementationOnce(actualFs.readdirSync)
      .mockImplementationOnce(() => { throw new Error('synthetic unreadable subtree'); });
    expect(leakCheck(dir)).toEqual(['board.json', 'scan incomplete: docs (cannot read directory)']);
  });

  it('refuses a file whose metadata cannot be inspected', () => {
    const dir = tree(['payload.txt']);
    vi.mocked(lstatSync).mockImplementationOnce(() => {
      throw new Error(`synthetic private filesystem detail: ${dir}`);
    });
    expect(leakCheck(dir)).toEqual(['scan incomplete: payload.txt (cannot inspect entry)']);
  });

  it('refuses links instead of trusting source exceptions or following directory cycles', () => {
    const dir = tree(['lanes/cockpit/cockpit.mjs', 'payload.txt']);
    symlinkSync(join(dir, 'payload.txt'), join(dir, 'lanes/cockpit/README.md'));
    symlinkSync(dir, join(dir, 'cycle'), 'dir');
    expect(leakCheck(dir)).toEqual(['cycle', join('lanes', 'cockpit', 'README.md')]);
  });

  it('refuses board.json outside the cockpit subtree and excludes private runtime state', () => {
    const dir = tree([
      ...sourceFiles,
      'docs/board.json',
      '.timmy/private/cockpit/board.json',
      '.timmy/private/cockpit/worker/2026-01-01.log',
    ]);
    expect(leakCheck(dir)).toEqual(['docs/board.json']);
  });
});
