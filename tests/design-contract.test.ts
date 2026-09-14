// THE VISUAL LAW GATE (ORDER ui-v3-t9r2, C1a): lanes/visual/tokens.json is the
// only source of colour.
//   (a) every theme token is bound to a law colour through one total table;
//   (b) no colour is chosen anywhere under src/tui (attic excluded): no hex,
//       no named Ink colour in any prop shape, no chalk colour member in any
//       chain shape, no aliased chalk, no other colour library, no raw escape,
//       no bare colour-name string in a component;
//   (c) the older DESIGN.md §9.3 structural rules are kept — they predate §12
//       and carry status PROVISIONAL until each has a demonstrated FAIL;
//   (d) §12 negative controls: every rule the gate enforces runs over a
//       known-defective artifact and must FAIL there, or the gate is not a gate.
// Admitted on purpose: Ink's dimColor / inverse / bold — SGR modifiers, not hues
// (dim yields the terminal's derived grey; inverse swaps two law colours).
// SCOPE, stated so the claim is no broader than the walk: this gate covers
// src/tui only. Terminal surfaces outside it still choose colours today —
// src/tui-opentui/spike.ts, scripts/timmy-ui-smoke.tsx, cli.tsx, headless.ts,
// src/utils/{markdown,humanlog,logserver,dash}.ts, src/utils/chatpage.html,
// src/forge/ForgePanel.tsx — and are C1b's item, not this gate's claim.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { theme, visualLaw, BINDINGS } from '../src/tui/theme.js';
import { lawViolations, sourceColorViolations } from '../src/tui/color-contract.js';

const TUI = join(process.cwd(), 'src', 'tui');
const LAW_PATH = join(process.cwd(), 'lanes', 'visual', 'tokens.json');
const CONTROL = join(process.cwd(), 'tests', 'fixtures', 'law-control.defective.tsx');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'attic') continue; // quarantined dead code — outside the contract
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e)) {
      out.push(p);
    }
  }
  return out;
};

const rel = (p: string): string => relative(TUI, p);

describe('the visual law — theme bound to lanes/visual/tokens.json', () => {
  it('the law file on disk is the one the theme imported', () => {
    const disk = JSON.parse(readFileSync(LAW_PATH, 'utf8'));
    expect(disk.color).toEqual(visualLaw.color);
    expect(disk.order).toBe('ui-v3-t9r2');
    expect(Object.keys(disk.evidence)).toEqual(expect.arrayContaining(['declared', 'constructed', 'checked', 'inferred', 'stale']));
    expect(disk.grid.columns).toBe(8);
  });

  it('the binding table is total: every theme token bound, every binding present, every value a law colour', () => {
    expect(lawViolations(theme, visualLaw.color, BINDINGS)).toEqual([]);
    expect(Object.keys(theme).sort()).toEqual(Object.keys(BINDINGS).sort());
  });

  it('the four accents and the ground are exactly the law; interaction is white, not a fifth hue', () => {
    expect(theme.seal).toBe('#33FF66');
    expect(theme.refuse).toBe('#FF3B3B');
    expect(theme.predict).toBe('#FFB020');
    expect(theme.generated).toBe('#8B5CF6');
    expect(theme.ground).toBe('#000000');
    expect(theme.textPrimary).toBe('#FFFFFF');
    expect(theme.accent).toBe(theme.structure);
    expect(theme.lineFocus).toBe(theme.structure);
    expect(theme.danger).toBe(theme.refuse);
  });

  it('theme exports the bound token set (old names kept for the call sites, law names added, dead ident removed)', () => {
    expect(Object.keys(theme).sort()).toEqual([
      'ground', 'surface', 'surfaceRaised', 'line', 'lineFocus',
      'textPrimary', 'textSecondary', 'textMuted',
      'accent', 'seal', 'warn', 'danger',
      'void', 'structure', 'grey1', 'grey2', 'grey3', 'sealDim', 'refuse', 'predict', 'generated',
    ].sort());
    expect('ident' in theme).toBe(false);
  });
});

describe('no colour is chosen outside theme.ts', () => {
  it('the walk reaches the tree it claims to (coverage control)', () => {
    const files = walk(TUI).map(rel);
    expect(files).toEqual(expect.arrayContaining(['theme.ts', 'color-contract.ts', 'components/ShellV2.tsx', 'components/ProgressBar.tsx', 'components/ShellChrome.tsx', 'ui/Card.tsx', 'panels/DashboardPanel.tsx']));
    expect(files.length).toBeGreaterThan(60);
    expect(files.some(f => f.startsWith('attic/'))).toBe(false);
  });

  it('every file under src/tui (theme.ts included) passes the source checker', () => {
    const bad = walk(TUI).flatMap(f => sourceColorViolations(readFileSync(f, 'utf8'), rel(f)));
    expect(bad).toEqual([]);
  });

  it('panels never touch chalk at all (DESIGN.md §9.3, kept verbatim)', () => {
    const bad = walk(join(TUI, 'panels'))
      .filter(f => /chalk\./.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(bad).toEqual([]);
  });
});

describe('§12 negative controls — the gate must FAIL on known-defective artifacts', () => {
  const law = visualLaw.color;

  it('the committed defective artifact fails every source rule (the gate.control artifact)', () => {
    const v = sourceColorViolations(readFileSync(CONTROL, 'utf8'), 'law-control.defective.tsx');
    const kinds = new Set(v.map(x => x.split(': ')[1]));
    expect([...kinds].sort()).toEqual([
      'another colour library', 'bare colour-name string in a component', 'chalk bound under another name', 'chalk colour member',
      'ink colour prop chooses a colour', 'object-literal colour', 'raw SGR escape', 'raw hex',
    ].sort());
    expect(v.length).toBeGreaterThan(20);
  });

  it('a theme carrying the old Clearinghouse green fails', () => {
    const v = lawViolations({ ...theme, seal: '#3BE08C' }, law, BINDINGS);
    expect(v.join('\n')).toMatch(/theme\.seal must be law\.seal/);
  });
  it('danger bound to amber fails the binding', () => {
    expect(lawViolations({ ...theme, danger: theme.predict }, law, BINDINGS).join('\n')).toMatch(/theme\.danger must be law\.refuse/);
  });
  it('a fifth hue fails even with every binding otherwise intact', () => {
    expect(lawViolations({ ...theme, accent: '#37D2FF' }, law, BINDINGS).join('\n')).toMatch(/theme\.accent must be law\.white/);
  });
  it('a structural token painted in an accent fails (line, textMuted, surfaceRaised, void, structure, grey3, sealDim)', () => {
    for (const [token, bad] of [['line', theme.seal], ['textMuted', theme.generated], ['surfaceRaised', theme.seal], ['void', theme.seal], ['structure', theme.refuse], ['grey3', theme.generated], ['sealDim', theme.refuse], ['textSecondary', theme.predict], ['surface', theme.generated], ['lineFocus', theme.predict]] as [string, string][]) {
      const v = lawViolations({ ...theme, [token]: bad }, law, BINDINGS);
      expect(v.length, token).toBeGreaterThan(0);
      expect(v.join('\n'), token).toContain(`theme.${token} must be`);
    }
  });
  it('an unbound extra token fails; a binding with no token fails; a binding to a colour the law lacks fails', () => {
    expect(lawViolations({ ...theme, foo: theme.seal }, law, BINDINGS).join('\n')).toMatch(/theme\.foo has no binding/);
    const { accent: _drop, ...without } = theme;
    expect(lawViolations(without, law, BINDINGS).join('\n')).toMatch(/theme\.accent is bound but missing/);
    expect(lawViolations(theme, law, { ...BINDINGS, seal: 'phosphor' }).join('\n')).toMatch(/bound to 'phosphor'/);
  });
  it('a theme whose colours are not the law on disk fails the disk check', () => {
    const disk = JSON.parse(readFileSync(LAW_PATH, 'utf8'));
    disk.color.seal.value = '#3BE08C';
    expect(disk.color).not.toEqual(visualLaw.color);
  });
  it('each evasion the reviewers found is caught', () => {
    const cases: [string, string][] = [
      ["<Text color={'cyan'}>", 'ink colour prop chooses a colour'],
      ['<Text color={"cyan"}>', 'ink colour prop chooses a colour'],
      ['<Text color={`cyan`}>', 'ink colour prop chooses a colour'],
      ["<Text color={ok ? 'green' : 'red'}>", 'ink colour prop chooses a colour'],
      ['<Text color = "red">', 'ink colour prop chooses a colour'],
      ['<Text\n  color=\n    "red"\n>', 'ink colour prop chooses a colour'],
      ['<Box borderColor={"cyan"}>', 'ink colour prop chooses a colour'],
      ['<Text color="rgb(1,2,3)">', 'ink colour prop chooses a colour'],
      ['<Text color="ansi256(196)">', 'ink colour prop chooses a colour'],
      ['<Text color="#fff">', 'raw hex'],
      ["'#abc'", 'raw hex'],
      ["'#fff8'", 'raw hex'],
      ["'#37D2FF80'", 'raw hex'],
      ["const m = { color: 'red' }", 'object-literal colour'],
      ["chalk.red.bold('x')", 'chalk colour member'],
      ["chalk.bold.red('x')", 'chalk colour member'],
      ["chalk.bgRed.white('x')", 'chalk colour member'],
      ["chalk['red']('x')", 'chalk colour member'],
      ['chalk.red`x`', 'chalk colour member'],
      ['const f = chalk.red', 'chalk colour member'],
      ['chalk.rgb(1,2,3)("x")', 'chalk colour member'],
      ["chalk.hex(theme.seal).bgRed('x')", 'chalk colour member'],
      ["import kolor from 'chalk'", 'chalk bound under another name'],
      ["import { red } from 'chalk'", 'chalk bound under another name'],
      ['const { red } = chalk', 'chalk bound under another name'],
      ["import pc from 'picocolors'", 'another colour library'],
      ["'\\x1b[31m'", 'raw SGR escape'],
    ];
    for (const [snippet, kind] of cases) {
      const v = sourceColorViolations(snippet, 'x.ts');
      expect(v.join('\n'), snippet).toContain(kind);
    }
    expect(sourceColorViolations("const c = 'cyan';\n<Text color={c}>x</Text>", 'x.tsx').join('\n')).toContain('bare colour-name string');
    expect(sourceColorViolations("const choices = ['Timmy Blue']; env.THEME = 'blue';", 'x.tsx')).toEqual([]); // a colour word as data is not a paint
    expect(sourceColorViolations("const c = ok ? 'green' : 'red';", 'x.tsx').join('\n')).toContain('bare colour-name string');
  });
  it('clean forms pass: theme tokens, chalk.hex(theme.x), chalk.bold/italic, dimColor, inverse, a 7-char hash, a comment', () => {
    const clean = [
      '<Text color={theme.seal} bold>ok</Text>',
      'chalk.hex(theme.textMuted)("x")',
      'chalk.bold(t); chalk.italic(t); chalk.strikethrough(t); chalk.level',
      '<Text dimColor inverse>x</Text>',
      "const h = '#c7f08a3'",
      '// see #abcdef in the ledger',
      '/* color="red" inside a comment */',
      "const url = 'https://x.y/#anchor'",
      "type Token = 'seal' | 'warn' | 'white'",
      "process.stdout.write('\\x1b[?1049h\\x1b[3J\\x1b[H'); s.replace(/\\x1b[()][A-B01]/g, '')",
    ].join('\n');
    expect(sourceColorViolations(clean, 'clean.ts')).toEqual([]);
  });
});

describe('DESIGN.md §9.3 structural rules — PROVISIONAL (admitted before §12, no FAIL demonstrated yet)', () => {
  it('no borderStyle= outside src/tui/ui/', () => {
    const bad = walk(TUI)
      .filter(f => !rel(f).startsWith('ui/'))
      .filter(f => readFileSync(f, 'utf8').includes('borderStyle='))
      .map(rel);
    expect(bad).toEqual([]);
  });

  it('every panel imports from the ui kit', () => {
    const bad = walk(join(TUI, 'panels'))
      .filter(f => !readFileSync(f, 'utf8').includes("'../ui/"))
      .map(rel);
    expect(bad).toEqual([]);
  });

  it('density budget: list-heavy views use BudgetList (§3.4)', () => {
    const listHeavy = [
      'components/EscrowReceiptsView.tsx',
      'panels/LanesPanel.tsx',
      'panels/BrowsePanel.tsx',
      'panels/FilesPanel.tsx',
      'panels/ProjectsPanel.tsx',
      'panels/ClipPanel.tsx',
      'panels/OptionsPanel.tsx',
      'panels/DashboardPanel.tsx',
    ];
    const bad = listHeavy
      .filter(f => !readFileSync(join(TUI, f), 'utf8').includes('BudgetList'));
    expect(bad).toEqual([]);
  });
});
