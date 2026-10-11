import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listLanes } from '../src/utils/dispatch.js';

// Fourth order, step 1 (found by CI on Node 24): a child process spawned with `shell: true` and an
// argument list makes Node 24 print a DEP0190 deprecation warning to stderr, once per process. The
// monitor called it while drawing HOME, and the 188-column warning landed on its full-screen frame.
// Lane availability is now a PATH lookup, with no shell.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('listLanes', () => {
  it('finds a lane\'s command on PATH, and only there', () => {
    const bin = mkdtempSync(join(tmpdir(), 'lanes-'));
    dirs.push(bin);
    writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'opencode'), 0o755);
    writeFileSync(join(bin, 'hermes'), 'not executable');
    const was = process.env.PATH;
    process.env.PATH = bin;
    try {
      const byId = Object.fromEntries(listLanes().map((l) => [l.id, l.available]));
      expect({ opencode: byId.opencode, hermes: byId.hermes, pi: byId.pi }).toEqual({ opencode: true, hermes: false, pi: false });
    } finally {
      process.env.PATH = was;
    }
  });
});

describe('no shell with an argument list', () => {
  // Node 24 warns on spawn/spawnSync/execFile with `shell: true` and arguments (DEP0190); in a
  // full-screen frame the warning is drawn over it. The product source keeps none.
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
  it('src/ has no shell: true', () => {
    const hits = files('src').filter((f) => /shell:\s*true/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});

describe('listLanes: a lane is ready only when everything it runs on is here', () => {
  const withPath = (names: string[], run: () => void): void => {
    const bin = mkdtempSync(join(tmpdir(), 'lanes-'));
    dirs.push(bin);
    for (const n of names) { writeFileSync(join(bin, n), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, n), 0o755); }
    const was = process.env.PATH;
    process.env.PATH = bin;
    try { run(); } finally { process.env.PATH = was; }
  };

  it('an API lane needs its key, not only curl, and names the key it needs', () => {
    withPath(['curl'], () => {
      const lanes = Object.fromEntries(listLanes({}).map((l) => [l.id, l]));
      expect(lanes.retool.available).toBe(false);
      expect(lanes.retool.key).toBe('RETOOL_API_KEY');
      expect(lanes.webcontainers.available).toBe(false);
      expect(lanes.webcontainers.key).toBe('WEBCONTAINERS_CLIENT_ID');
    });
  });

  it('a set key makes the API lane ready; a placeholder does not; the value never appears', () => {
    withPath(['curl'], () => {
      const set = listLanes({ RETOOL_API_KEY: 'sk-test-0000' });
      expect(set.find((l) => l.id === 'retool')?.available).toBe(true);
      expect(JSON.stringify(set)).not.toContain('sk-test-0000');
      const placeholder = listLanes({ RETOOL_API_KEY: 'paste_your_key_here' });
      expect(placeholder.find((l) => l.id === 'retool')?.available).toBe(false);
    });
  });

  it('hyperframes needs its own command; npx alone only means it could be fetched', () => {
    withPath(['npx'], () => {
      expect(listLanes({}).find((l) => l.id === 'hyperframes')?.available).toBe(false);
    });
    withPath(['npx', 'hyperframes'], () => {
      expect(listLanes({}).find((l) => l.id === 'hyperframes')?.available).toBe(true);
    });
  });
});
