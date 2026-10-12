// R4 (H103): the monitor's chat words and commands (src/tui/monitor-chat.ts), pure: which lines are commands (none is ever
// sent to a model), the flash wrapped whole (D7), the drawer's rows wrapped and bounded (D10: a notice the agent gives, the
// last-resort fallback's included, is shown whole), the NEEDS YOU box, and the words a turn ends with.
import { describe, expect, it } from 'vitest';
import { drawerRows, flashRows, monitorSlash, MONITOR_UNKNOWN_WORDS, needsYouRows, turnFlash } from '../src/tui/monitor-chat.js';
import { MONITOR_STUDIO_WORDS } from '../src/setup/surfaces.js';

describe('the monitor\'s commands (D1e)', () => {
  it('runs /setup, /studio, /model test and /storyboard; any other line that starts with / is unknown; the rest is a message', () => {
    expect(['/setup', '/setup key', '/studio', '/studio a tray', '/model test', '/storyboard a tray demo', '/storyboard'].map(monitorSlash))
      .toEqual(['setup', 'setup', 'studio', 'studio', 'model-test', 'storyboard', 'storyboard']);
    expect(['/model', '/models', '/help', '/storyboards x', '/ studio'].map(monitorSlash)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect(['hello', ' a path /etc/hosts', ''].map(monitorSlash)).toEqual([null, null, null]);
    expect(MONITOR_UNKNOWN_WORDS).toBe('Unknown here: the monitor\'s chat runs /setup, /studio, /storyboard and /model test; the REPL runs the rest.');
  });
});

describe('the flash line (D7)', () => {
  it('wraps whole words within the width, every word kept; only past its row limit does it end with …', () => {
    const rows = flashRows(MONITOR_STUDIO_WORDS, 80, 6);
    expect(rows.every((r) => r.length <= 80)).toBe(true);
    expect(rows.join(' ').replace(/\s+/g, ' ')).toBe(MONITOR_STUDIO_WORDS);
    expect(rows.at(-1)).toBe('cannot.');
    const cut = flashRows(MONITOR_STUDIO_WORDS, 40, 2);
    expect(cut).toHaveLength(2);
    expect(cut[1].endsWith('…')).toBe(true);
    expect(flashRows('', 80, 3)).toEqual([]);
  });
});

describe('the drawer\'s rows (D10)', () => {
  const base = { width: 60, max: 30, title: 'SOVEREIGN CHAT · local qwen3:8b · Ollama', status: 'Local: qwen3:8b on this computer\'s Ollama.', notes: [], input: 'hi' };
  it('shows a notice the agent gave whole (the last-resort fallback), the answer, and never a row wider than the drawer', () => {
    const notice = '⚙️ **[SYSTEM]** OpenRouter failed: fake/model: 503 Service Unavailable; answered by local granite4.2:latest on this computer\'s Ollama, the last-resort fallback.';
    const rows = drawerRows({ ...base, messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: notice }, { role: 'assistant', content: 'A long answer '.repeat(20) }] });
    expect(rows.every((r) => r.text.length <= 60)).toBe(true);
    const text = rows.map((r) => r.text).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain('· OpenRouter failed: fake/model: 503 Service Unavailable; answered by local granite4.2:latest on this computer\'s Ollama, the last-resort fallback.');
    expect(text).toContain('you: hello');
    expect(rows.filter((r) => r.tone === 'note').length).toBeGreaterThan(0);
    expect(rows.at(-1)).toEqual({ text: '[Enter] send · [Esc] leave · digits are text', tone: 'keys' });
  });
  it('fits its rows: the newest messages first, and a row says how many earlier ones are not shown', () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}` }));
    const rows = drawerRows({ ...base, max: 10, messages });
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows.map((r) => r.text)).toContain('ai:  message 11');
    expect(rows.some((r) => /earlier messages not shown/.test(r.text))).toBe(true);
  });
  it('a refusal\'s lines are its own tone (red where drawn), and a failure\'s error shows only when no lines came', () => {
    const rows = drawerRows({ ...base, messages: [], notes: ['Error: no model key, and the chat is not set to the local model, so this message was not sent.', 'Nothing was sent to any model.'], error: 'also an error' });
    expect(rows.filter((r) => r.tone === 'error').map((r) => r.text).join(' ')).toContain('Error: no model key');
    expect(rows.some((r) => r.text.includes('also an error'))).toBe(false);
  });
});

describe('the NEEDS YOU box and a turn\'s last words', () => {
  it('names the tool and its target, why, the whole command when one line cannot show it, and the keys it offers', () => {
    const rows = needsYouRows({ tool: 'write_project_file', reason: 'changes a file in your project', summary: 'notes.md' }, 70);
    expect(rows.map((r) => r.text)).toEqual(['NEEDS YOU · write_project_file: notes.md', '  changes a file in your project', '  y allow once · a allow for this session · n, Esc or Enter deny (nothing runs)']);
    const shell = needsYouRows({ tool: 'run_in_daytona_workspace', reason: 'runs a shell command on this machine', summary: 'x', detail: 'line one\nline two', session: false }, 70);
    expect(shell.map((r) => r.text)).toEqual(['NEEDS YOU · run_in_daytona_workspace', '  runs a shell command on this machine', '    line one', '    line two', '  y allow once · n, Esc or Enter deny (nothing runs)']);
  });
  it('says the outcome, who answered, the cost in words and the receipt; a refusal its first line', () => {
    expect(turnFlash({ status: 'answered', text: 'x', sent: true, costWords: 'no charge (local endpoint)', model: 'qwen3:8b', receipt: 'sha256_0123456789abcdef' }))
      .toBe('Answered by qwen3:8b · no charge (local endpoint) · receipt 01234567');
    expect(turnFlash({ status: 'refused', text: '', sent: false, costWords: 'no request, no cost', lines: ['Error: no model key, and the chat is not set to the local model, so this message was not sent.'] }))
      .toBe('Not sent: no model key, and the chat is not set to the local model, so this message was not sent.');
    expect(turnFlash({ status: 'failed', text: '', sent: false, costWords: 'no request, no cost', lines: ['Error: Ollama at 127.0.0.1:9 did not answer, so nothing was sent.', 'Nothing was sent to any model.'] }))
      .toBe('The turn failed: Ollama at 127.0.0.1:9 did not answer, so nothing was sent. Nothing was sent to any model.');
  });
});
