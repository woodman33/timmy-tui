import { describe, expect, it } from 'vitest';
import { glyphSet } from '../src/term/glyphs.js';
import { COMMANDS, runSlash, type ReplContext } from '../src/repl/commands.js';

// Slash commands come from one registry, run locally, and never reach the model (playbook §17.7).
const ctx = () => {
  const printed: string[] = [];
  const state = { model: 'anthropic/claude-sonnet-4.5', sessions: 0, watched: 0 };
  const c: ReplContext = {
    agent: { getModel: () => state.model, setModel: (m) => { state.model = m; }, startSession: () => `s${++state.sessions}` },
    print: (segments) => printed.push(segments.map((s) => s.text).join('')),
    glyphs: glyphSet(false),
    themeInfo: () => ({ source: 'TIMMY_PALETTE=night', background: '#000000', secondary: 'white (37)', tint: '48;2;31;31;31', files: '/pkg/assets/themes' }),
    receipts: () => ({ verify: { ok: true, count: 12 }, recent: [{ hash: 'sha256_1fb6eb93aa00', kind: 'model.policy', when: '2026-10-06 23:41' }] }),
    openWatch: () => { state.watched++; return 'in a tmux pane'; },
    setup: () => [[{ text: '  SETUP CHECK' }], [{ text: '  ✓ RECEIPT 3f9a2c1d' }, { text: '  setup check sealed and verified' }]],
    lanes: () => [{ id: 'openhands', label: 'OpenHands', available: true }, { id: 'pi', label: 'Pi', available: false, install: 'npm i -g pi-agent' }],
    openCenter: () => 'Cockpit opened in a new zellij session.',
  };
  return { c, printed, state };
};

describe('slash commands', () => {
  it('builds /help from the registry, name then description', () => {
    const { c, printed } = ctx();
    expect(runSlash('/help', c)).toBe('handled');
    expect(printed).toEqual(COMMANDS.map((cmd) => `  /${cmd.name.padEnd(11)} ${cmd.description}`));
  });
  it('answers an unknown command locally and suggests the nearest one', () => {
    const { c, printed } = ctx();
    expect(runSlash('/hepl', c)).toBe('handled');
    expect(printed).toEqual(['  Unknown command: /hepl. Did you mean /help? Type /help for available commands.']);
  });
  // C-14: the setup check a first run offers runs here, from the same registry.
  it('/setup prints the setup check, every line within 60 columns of /help too', () => {
    const { c, printed } = ctx();
    runSlash('/setup', c);
    expect(printed).toEqual(['  SETUP CHECK', '  ✓ RECEIPT 3f9a2c1d  setup check sealed and verified']);
    const help: string[] = [];
    runSlash('/help', { ...c, print: (seg) => help.push(seg.map((x) => x.text).join('')) });
    expect(help.some((l) => l.startsWith('  /setup '))).toBe(true);
    expect(help.filter((l) => l.length > 60)).toEqual([]);
  });
  // C-10: /lanes and /center from the same registry (the plan's /lanes and /cockpit; the verb is
  // `timmy center`, row 11's ruling). A missing lane says how to install it, in words, not color.
  it('/lanes lists every lane, ready or not, and how to install a missing one', () => {
    const { c, printed } = ctx();
    runSlash('/lanes', c);
    expect(printed).toEqual(['  * openhands  OpenHands - ready', '    pi         Pi - not installed: npm i -g pi-agent']);
  });
  it('/center opens the cockpit and says where', () => {
    const { c, printed } = ctx();
    runSlash('/center', c);
    expect(printed).toEqual(['  Cockpit opened in a new zellij session.']);
  });
  it('shows and sets the model, starts a new conversation, and exits', () => {
    const { c, printed, state } = ctx();
    runSlash('/model', c);
    runSlash('/model openai/gpt-5.5', c);
    runSlash('/new', c);
    expect(printed).toEqual(['  Model: anthropic/claude-sonnet-4.5', '  Model: anthropic/claude-sonnet-4.5 -> openai/gpt-5.5', '  New conversation.']);
    expect([state.model, state.sessions]).toEqual(['openai/gpt-5.5', 1]);
    expect(runSlash('/exit', c)).toBe('exit');
  });
});

describe('cockpit commands', () => {
  it('/theme says what Timmy measured and where the palettes are', () => {
    const { c, printed } = ctx();
    runSlash('/theme', c);
    expect(printed).toEqual([
      '  Palette    TIMMY_PALETTE=night',
      '  Measured   ground #000000 - secondary white (37) - input tint 48;2;31;31;31',
      '  Themes     /pkg/assets/themes (Ghostty, iTerm2, WezTerm, kitty, Alacritty, zellij)',
    ]);
  });
  it('/receipts verifies the chain before it shows anything as verified', () => {
    const { c, printed } = ctx();
    runSlash('/receipts', c);
    expect(printed).toEqual(['  [OK] Chain verified  12 receipts', '  * sha256_1fb6eb93  model.policy  2026-10-06 23:41']);
    const empty = ctx();
    empty.c.receipts = () => ({ verify: { ok: true, count: 0 }, recent: [] });
    runSlash('/receipts', empty.c);
    expect(empty.printed).toEqual(['  No receipts yet: nothing to verify.']);
    const one = ctx();
    one.c.receipts = () => ({ verify: { ok: true, count: 1 }, recent: [] });
    runSlash('/receipts', one.c);
    expect(one.printed).toEqual(['  [OK] Chain verified  1 receipt']);
    const broken = ctx();
    broken.c.receipts = () => ({ verify: { ok: false, count: 3, reason: 'hash mismatch at #2' }, recent: [] });
    runSlash('/receipts', broken.c);
    expect(broken.printed).toEqual(['  [FAIL] Chain broken  hash mismatch at #2']);
  });
  it('/watch opens the full-screen monitor and says where', () => {
    const { c, printed, state } = ctx();
    runSlash('/watch', c);
    expect([state.watched, printed]).toEqual([1, ['  Watch opened in a tmux pane.']]);
  });
});

