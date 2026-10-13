/**
 * Round R1, gap 5: Timmy Homebrew as a macOS Terminal profile, with Monaspace Argon at 14 points. A
 * `.terminal` file keeps each color and the font as an NSKeyedArchiver archive (a binary plist); this
 * reads ours back with Python's plistlib, as the checks on the Mac read it with Terminal's own classes.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { bplist, Real, Uid } from '../src/term/bplist.js';
import { themeFiles } from '../src/term/theme-files.js';
import { TIMMY_HOMEBREW } from '../src/term/palettes.js';
import { TYPE } from '../src/theme/tokens.js';

const python = spawnSync('python3', ['--version']).status === 0;

/** Parses a plist (XML or binary) with Python and prints what the test asks for, as JSON. */
function readPlist(bytes: Uint8Array | string, script: string): any {
  const r = spawnSync('python3', ['-I', '-c', `import plistlib, sys, json, base64\nd = plistlib.loads(sys.stdin.buffer.read())\n${script}`], { input: Buffer.from(bytes), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe.skipIf(!python)('the binary plist writer', () => {
  it('writes what plistlib reads back: strings, integers, reals, booleans, data, UIDs, arrays, dictionaries', () => {
    const value = { name: 'Timmy', count: 300, big: 70000, size: new Real(14), ratio: 0.5, on: true, off: false, raw: new Uint8Array([0, 1, 2]), ref: new Uid(7), list: ['a', 'b'], long: 'x'.repeat(40) };
    const out = readPlist(bplist(value), "d['raw'] = list(d['raw']); d['ref'] = d['ref'].data; print(json.dumps(d))");
    expect(out).toEqual({ name: 'Timmy', count: 300, big: 70000, size: 14, ratio: 0.5, on: true, off: false, raw: [0, 1, 2], ref: 7, list: ['a', 'b'], long: 'x'.repeat(40) });
  });
});

describe.skipIf(!python)('Timmy Homebrew.terminal', () => {
  const file = themeFiles()['terminal/Timmy Homebrew.terminal'];
  const decode = `
def obj(blob):
    p = plistlib.loads(blob); o = p['$objects']; root = o[p['$top']['root'].data]
    return {k: (o[v.data] if isinstance(v, plistlib.UID) else v) for k, v in root.items() if k != '$class'} | {'class': o[root['$class'].data]['$classname']}
out = {}
for k, v in d.items():
    if isinstance(v, bytes):
        x = obj(v)
        if 'NSRGB' in x:
            r, g, b = [float(c) for c in x['NSRGB'].rstrip(b'\\0').split()[:3]]
            out[k] = '#%02X%02X%02X' % (round(r * 255), round(g * 255), round(b * 255))
        else:
            out[k] = [x['NSName'], x['NSSize'], x['class']]
    else:
        out[k] = v
print(json.dumps(out))`;
  it('is a Terminal profile named Timmy Homebrew, in Monaspace Argon at 14 points', () => {
    const p = readPlist(file, decode);
    expect(p).toMatchObject({ name: 'Timmy Homebrew', type: 'Window Settings', Font: [TYPE.postscript, TYPE.terminalSize, 'NSFont'], FontAntialias: true });
  });
  it('carries the palette: ground, text, cursor, selection and the 16 slots', () => {
    const p = readPlist(file, decode);
    expect(p).toMatchObject({
      BackgroundColor: TIMMY_HOMEBREW.background, TextColor: TIMMY_HOMEBREW.foreground, CursorColor: TIMMY_HOMEBREW.cursor, SelectionColor: TIMMY_HOMEBREW.selection,
      ANSIBlackColor: TIMMY_HOMEBREW.black, ANSIGreenColor: TIMMY_HOMEBREW.green, ANSIBrightBlackColor: TIMMY_HOMEBREW.brightBlack, ANSIBrightWhiteColor: TIMMY_HOMEBREW.brightWhite,
    });
    expect(Object.keys(p).filter((k) => /^ANSI.*Color$/.test(k))).toHaveLength(16);
  });
});
