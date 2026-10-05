// Every tracked Python file must parse on Python 3.9: macOS still ships /usr/bin/python3 3.9, the lanes are spawned as plain
// `python3`, and founder-terminal declares requires-python >= 3.9. scripts/py-compat-guard.py checks that with whatever
// python3 runs it; on 3.12+ (CI) it adds a tokenizer pass for the PEP 701 f-string forms that ast's feature_version does not
// catch. Sourcery found one in lanes/geo/bench_loader.py; the guard's first run found scripts/roboflow-bridge.py, which parsed
// on no Python at all (one misplaced parenthesis), so the Roboflow bridge could never start.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const guard = join(ROOT, 'scripts', 'py-compat-guard.py');
const version = (bin: string): [number, number] | null => {
  const r = spawnSync(bin, ['-c', 'import sys; print("%d %d" % sys.version_info[:2])'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const [a, b] = r.stdout.trim().split(' ').map(Number); return [a, b];
};
const here = version('python3');
const atLeast = (v: [number, number] | null, minor: number) => !!v && v[0] === 3 && v[1] >= minor;
// older interpreters, when this machine has them, parse every file with their own parser: the ground truth for that version
const older = ['python3.9', 'python3.10', 'python3.11'].filter((b) => version(b) !== null);
const guardRun = (bin: string, args: string[]) => {
  const r = spawnSync(bin, [guard, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
};

describe('python compatibility (floor 3.9)', () => {
  it.skipIf(!atLeast(here, 9))('every tracked .py parses for Python 3.9 (guard on this python3)', () => {
    const { status, out, stderr } = guardRun('python3', []);
    expect(out, stderr).not.toBeNull();
    expect(out.offenders, JSON.stringify(out.offenders, null, 1)).toEqual([]);
    expect(status).toBe(0); expect(out).toMatchObject({ ok: true, floor: '3.9' }); expect(out.files).toBeGreaterThan(50);
  });

  it.skipIf(!atLeast(here, 12))('on 3.12+ the guard catches the f-string forms that only parse there, and passes the ones that parse everywhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'py-compat-'));
    const bad = join(dir, 'bad.py'); const good = join(dir, 'good.py');
    writeFileSync(bad, [
      'd = {"k": 1}',
      'a = f"{d["k"]}"',                                   // 2: quote reused inside a field (the bench_loader.py form)
      "b = f\"{'\\n'.join(['x'])}\"",                       // 3: backslash inside a field
      'c = f"{f"{d}"}"',                                   // 4: nested f-string with the enclosing quote
      'e = f"""{d # note',                                 // 5: comment inside a field
      '}"""',
      '',
    ].join('\n'));
    writeFileSync(good, [
      'd = {"k": 1}; w = 5',
      "a = f\"{d['k']}\"",
      'b = f"""{"k"}"""',
      'c = f"{d!r:>{w}} {{literal}} {f\'{w}\'}"',
      'e = f"line\\n{w}"',
      'g = f"""{w',
      '}"""',
      '',
    ].join('\n'));
    const r = guardRun('python3', [bad, good]);
    expect(r.status).toBe(1); expect(r.out.pep701_check).toBe(true);
    expect([...new Set(r.out.offenders.map((o: any) => `${o.file === bad ? 'bad' : 'good'}:${o.line}`))]).toEqual(['bad:2', 'bad:3', 'bad:4', 'bad:5']);
    expect(guardRun('python3', [good]).status).toBe(0);
    expect(guardRun('python3', ['--floor', '2.7', good]).status).toBe(64);
  });

  it.skipIf(older.length === 0)('each older python on this machine parses every tracked .py with its own parser', () => {
    for (const bin of older) {
      const { status, out, stderr } = guardRun(bin, []);                // also proves the guard itself runs on that version
      expect(out, `${bin}: ${stderr}`).not.toBeNull();
      expect(out.offenders, `${bin}: ${JSON.stringify(out.offenders)}`).toEqual([]);
      expect(status, bin).toBe(0); expect(out.pep701_check).toBe(false);
    }
  });
});
