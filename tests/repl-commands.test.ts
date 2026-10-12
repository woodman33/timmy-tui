import { describe, expect, it } from 'vitest';
import { glyphSet } from '../src/term/glyphs.js';
import { COMMANDS, runSlash, type ReplContext, type ThemeInfo, GROUPS, GROUP_LABEL } from '../src/repl/commands.js';
import { needsPerson } from '../src/ops/act.js';
import { SURFACES_LINE } from '../src/setup/surfaces.js';

// Slash commands come from one registry, run locally, and never reach the model (playbook §17.7).
const NIGHT_INFO: ThemeInfo = {
  source: 'TIMMY_PALETTE=night', background: '#000000', secondary: 'white (37)', tint: '48;2;31;31;31', files: '/pkg/assets/themes',
  color: true, meanings: { verified: 2, estimate: 3, failure: 1, ai: 5 },
};
const ctx = (info: ThemeInfo = NIGHT_INFO) => {
  const printed: string[] = [];
  const state = { model: 'anthropic/claude-sonnet-4.5', sessions: 0, watched: 0 };
  const c: ReplContext = {
    agent: { getModel: () => state.model, setModel: (m) => { state.model = m; }, startSession: () => `s${++state.sessions}` },
    print: (segments) => printed.push(segments.map((s) => s.text).join('')),
    glyphs: glyphSet(false),
    themeInfo: () => ({ ...info }),
    receipts: () => ({ verify: { ok: true, count: 12 }, recent: [{ hash: 'sha256_1fb6eb93aa00', kind: 'model.policy', when: '2026-10-06 23:41' }] }),
    openWatch: () => { state.watched++; return 'in a tmux pane'; },
    setup: () => [[{ text: '  SETUP CHECK' }], [{ text: '  ✓ RECEIPT 3f9a2c1d' }, { text: '  setup check sealed and verified' }]],
    lanes: () => [{ id: 'openhands', label: 'OpenHands', available: true }, { id: 'pi', label: 'Pi', available: false, install: 'npm i -g pi-agent' }],
    openCenter: () => 'Cockpit opened in a new zellij session.',
  };
  return { c, printed, state };
};

describe('slash commands', () => {
  it('builds /help from the registry in sections (work, look, setup, session), name then description', () => {
    const { c, printed } = ctx();
    expect(runSlash('/help', c)).toBe('handled');
    // R4 (H98): the three surfaces first, in one line wrapped within 60 columns (never cut)
    const top = ['  Studio /studio · Control Room /room', '  God\'s Eye View /overview', '  all three in your browser: /board live'];
    expect(top.map((l) => l.trim()).join(' · ')).toBe(SURFACES_LINE);
    expect(printed).toEqual([...top, ...GROUPS.flatMap((g) => [`  ${GROUP_LABEL[g]}`, ...COMMANDS.filter((cmd) => cmd.group === g).map((cmd) => `  /${cmd.name.padEnd(11)} ${cmd.description}`)])]);
    expect(COMMANDS.every((cmd) => GROUPS.includes(cmd.group))).toBe(true);
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
  // R4 (H98): a lane's program on PATH is found, not checked (it used to say "ready": nothing here ran it)
  it('/lanes lists every lane, found or not, and how to install a missing one', () => {
    const { c, printed } = ctx();
    runSlash('/lanes', c);
    expect(printed).toEqual(['  * openhands  OpenHands - found (not checked)', '    pi         Pi - not installed: npm i -g pi-agent']);
    expect(printed.join('\n')).not.toMatch(/\bready\b|available/);
  });
  // R4 (H98): Timmy Studio is Timmy Canvas: /studio takes /canvas open's own path (a FAKE canvas view records what it is asked)
  it('/studio opens Timmy Studio by /canvas open\'s path; /canvas stays', async () => {
    const { c, printed } = ctx();
    const asked: string[] = [];
    const canvas = async (args: string) => { asked.push(args); return [[{ text: `  canvas ${args || '(state)'}` }]]; };
    await runSlash('/canvas open', { ...c, canvas });
    await runSlash('/studio', { ...c, canvas });
    await runSlash('/studio open', { ...c, canvas });
    await runSlash('/canvas', { ...c, canvas });
    expect(asked).toEqual(['open', 'open', 'open', '']);
    expect(printed).toEqual(['  canvas open', '  Timmy Studio (Timmy Canvas), as /canvas open:', '  canvas open', '  Timmy Studio (Timmy Canvas), as /canvas open:', '  canvas open', '  canvas (state)']);
    printed.length = 0;
    runSlash('/studio a tray', { ...c, canvas });
    expect(asked).toHaveLength(4);
    expect(printed).toEqual(['  Usage: /studio (opens Timmy Studio, as /canvas open; /canvas: its state)']);
    printed.length = 0;
    await runSlash('/studio', c);
    expect(printed).toEqual(['  Timmy Studio (Timmy Canvas) is not available here.']);
  });
  // R4 (H98): /setup hands its words to the setup (/setup key), and waits for the guided setup when it asks (a FAKE setup)
  it('/setup passes its words on, and prints what a setup that waits returns', async () => {
    const { c, printed } = ctx();
    const asked: string[] = [];
    const setup = async (args: string) => { asked.push(args); return [[{ text: `  set up ${args || '(all)'}` }]]; };
    const ran = runSlash('/setup key', { ...c, setup });
    expect(ran).toBeInstanceOf(Promise);
    expect(await ran).toBe('handled');
    await runSlash('/setup', { ...c, setup });
    expect(asked).toEqual(['key', '']);
    expect(printed).toEqual(['  set up key', '  set up (all)']);
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
  it('R4 (H88; r23): /quit is /exit, and /help says so (it was unknown, and suggested /edit)', () => {
    const { c, printed } = ctx();
    expect(runSlash('/quit', c)).toBe('exit');
    expect(printed).toEqual([]);
    const help: string[] = [];
    runSlash('/help', { ...c, print: (seg) => help.push(seg.map((x) => x.text).join('')) });
    expect(help).toContain('  /exit        Quit Timmy (/quit does the same)');
    expect(needsPerson('/quit')).toBe('/quit ends the REPL');
  });
});

describe('cockpit commands', () => {
  it('/theme says what Timmy measured, the color each meaning takes here, and where the palettes are', () => {
    const { c, printed } = ctx();
    runSlash('/theme', c);
    expect(printed).toEqual([
      '  Palette    TIMMY_PALETTE=night',
      '  Measured   ground #000000 - secondary white (37) - input tint 48;2;31;31;31',
      '  Meanings   verified green - estimate yellow - failure red - model violet',
      '  Themes     /pkg/assets/themes (Homebrew, Night, Day: timmy theme install)',
    ]);
  });
  // Fourth order, step 2 (readability): a meaning with no color here is named, with why, and the fallback
  // for an unknown ground is said where it applies, with what to do for color (README, "Terminal colors").
  it('/theme names a meaning that has no color on this ground, and a bright twin by its name', () => {
    const { c, printed } = ctx({ ...NIGHT_INFO, source: 'measured (OSC 11)', background: '#FFFFFF', meanings: { verified: null, estimate: null, failure: 9, ai: 5 } });
    runSlash('/theme', c);
    expect(printed.slice(2, 4)).toEqual([
      '  Meanings   verified no color - estimate no color - failure bright red - model violet',
      '             no color: under 4.5:1 on this ground, so the mark and the word carry it',
    ]);
  });
  it('/theme says the fallback when the terminal did not say its background, and how to get color', () => {
    const { c, printed } = ctx({ ...NIGHT_INFO, source: 'unknown (the terminal did not answer)', background: null, secondary: 'your text color', tint: null, meanings: { verified: null, estimate: null, failure: null, ai: null } });
    runSlash('/theme', c);
    expect(printed.slice(2, 4)).toEqual([
      '  Meanings   no color: the terminal did not say its background, so marks and words carry them',
      '  For color  timmy theme install, then TIMMY_PALETTE=homebrew (or night, day)',
    ]);
  });
  it('/theme says when color is off altogether', () => {
    const { c, printed } = ctx({ ...NIGHT_INFO, color: false, meanings: { verified: null, estimate: null, failure: null, ai: null } });
    runSlash('/theme', c);
    expect(printed[2]).toBe('  Meanings   no color: color is off here (NO_COLOR, or no color support), so marks and words carry them');
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

