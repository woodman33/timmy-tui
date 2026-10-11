// R1 workspace demo (2026-10-08): /project changes the working folder; the conversation log must keep
// writing where it was made, and a new folder's log is made by its first message, not on open.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationManager } from '../src/agent/conversation.js';

const dirs: string[] = [];
const start = process.cwd();
afterEach(() => { process.chdir(start); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'conv-')); dirs.push(d); return d; };

describe('the conversation log', () => {
  it('stays in the folder it was made in after the working folder changes, and is made by the first message', () => {
    const a = temp(); const b = temp();
    process.chdir(a);
    const m = new ConversationManager('.sessions');
    expect(existsSync(join(a, '.sessions'))).toBe(false);
    process.chdir(b);
    m.startNew();
    m.appendMessage({ role: 'user', content: 'hi' } as never);
    expect(readdirSync(join(a, '.sessions')).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
    expect(existsSync(join(b, '.sessions'))).toBe(false);
    expect(m.directory).toBe(join(a, '.sessions'));
  });
});
