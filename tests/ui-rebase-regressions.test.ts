import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectSession } from '../src/utils/session.js';
import { wrapText } from '../src/tui/utils/rows.js';

// Session classification tests never inspect the real parent-process tree.
vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 1, stdout: '' })),
}));

describe('rebased UI regression controls', () => {
  beforeEach(() => {
    for (const key of ['CLAUDECODE', 'QWEN_CODE', 'QWEN_MODEL', 'OPENROUTER_MODEL', 'ANTHROPIC_MODEL']) {
      vi.stubEnv(key, undefined);
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['QWEN_CODE', 'QWEN_MODEL'])('prefers explicit %s to an inherited Claude marker', key => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv(key, key === 'QWEN_MODEL' ? 'fixture-qwen' : '1');
    vi.stubEnv('OPENROUTER_MODEL', 'fixture-qwen');
    vi.stubEnv('ANTHROPIC_MODEL', 'fixture-parent');
    expect(detectSession()).toEqual({ actor: 'qwen-cli', short: 'qwen', hands: 'fixture-qwen' });
  });

  it('still identifies a standalone Claude session', () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('ANTHROPIC_MODEL', 'fixture-claude');
    expect(detectSession()).toEqual({ actor: 'claude-code', short: 'claude', hands: 'fixture-claude' });
  });

  it('preserves source indentation on every prompt line', () => {
    expect(wrapText('    first\n  next\n\n    last', 12)).toEqual(['    first', '  next', '', '    last']);
  });

  it('counts indentation when wrapping while keeping ordinary soft-wrap behavior', () => {
    expect(wrapText('    one two', 7)).toEqual(['    one', 'two']);
    expect(wrapText('one two three', 7)).toEqual(['one two', 'three']);
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('retains whitespace-only source rows and bounds wide indentation', () => {
    const rows = wrapText('         x\n   ', 4);
    expect(rows).toEqual(['    ', '    ', ' x', '   ']);
    expect(rows.every(row => row.length <= 4)).toBe(true);
  });
});
