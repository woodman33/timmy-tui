import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editExternally } from '../src/repl/external-editor.js';

// C-10: Ctrl+G's editor. $VISUAL, then $EDITOR, then vi; the command may carry its own arguments
// ("code --wait"), and the file is passed as an argument, never parsed by a shell. The file is 0600
// and removed afterwards; an editor that fails leaves the input as it was (null).
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function script(body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'timmy-ed-'));
  dirs.push(d);
  const p = join(d, 'ed.sh');
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('editExternally', () => {
  it('opens the text in $VISUAL before $EDITOR and returns what was saved, removing the file', () => {
    const rec = script('cat "$1" > "$(dirname "$0")/seen"; printf "from the editor\\n" > "$1"; echo "$1" > "$(dirname "$0")/path"');
    const out = editExternally('draft', { VISUAL: rec, EDITOR: '/bin/false' }, { stdio: 'ignore' });
    expect(out).toBe('from the editor');
    const dir = rec.replace(/\/ed\.sh$/, '');
    const path = readFileSync(join(dir, 'path'), 'utf8').trim();
    expect(readFileSync(join(dir, 'seen'), 'utf8')).toBe('draft');
    expect(existsSync(path)).toBe(false);
  });
  it('keeps the editor command\'s own arguments and passes the file as an argument', () => {
    const rec = script('[ "$1" = "--wait" ] && printf "ok" > "$2"');
    expect(editExternally('x', { EDITOR: `${rec} --wait` }, { stdio: 'ignore' })).toBe('ok');
  });
  it('returns null when the editor fails, so the input stays as it was', () => {
    expect(editExternally('x', { EDITOR: '/bin/false' }, { stdio: 'ignore' })).toBeNull();
  });
});
