/**
 * Timmy Night and Day as terminal theme files (DESIGN.md §10 B2: the brand lives in the palette).
 * scripts/ui/themes.ts writes these to assets/themes; tests/ui-themes.test.ts checks for drift.
 */
import { blend, hexToRgb, isLight, rgbToHex } from './color.js';
import { keyedArchive, Real, Uid } from './bplist.js';
import { SLOT_NAMES, TIMMY_DAY, TIMMY_HOMEBREW, TIMMY_NIGHT, type TerminalPalette } from './palettes.js';
import { TYPE } from '../theme/tokens.js';

const HEADER = 'generated from src/term/palettes.ts by scripts/ui/themes.ts; do not edit';
const lower = (hex: string): string => hex.toLowerCase();
const slots = (p: TerminalPalette): string[] => SLOT_NAMES.map((n) => lower(p[n]));
const cursor = (p: TerminalPalette): string => lower(p.cursor ?? p.foreground);
const selection = (p: TerminalPalette): string => lower(p.selection ?? p.black);
const fileStem = (p: TerminalPalette): string => p.name.toLowerCase().replace(/\s+/g, '-');

function ghostty(p: TerminalPalette): string {
  return [
    `# ${p.name} for Ghostty (${HEADER})`,
    `background = ${lower(p.background)}`,
    `foreground = ${lower(p.foreground)}`,
    'background-opacity = 1',
    `cursor-color = ${cursor(p)}`,
    `selection-background = ${selection(p)}`,
    ...slots(p).map((hex, i) => `palette = ${i}=${hex}`),
    '',
  ].join('\n');
}

function kitty(p: TerminalPalette): string {
  return [
    `# ${p.name} for kitty (${HEADER})`,
    `foreground ${lower(p.foreground)}`,
    `background ${lower(p.background)}`,
    `cursor ${cursor(p)}`,
    `selection_background ${selection(p)}`,
    ...slots(p).map((hex, i) => `color${i} ${hex}`),
    '',
  ].join('\n');
}

function alacritty(p: TerminalPalette): string {
  const s = slots(p);
  const group = (from: number) =>
    ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].map((n, i) => `${n} = "${s[from + i]}"`);
  return [
    `# ${p.name} for Alacritty (${HEADER})`,
    '[colors.primary]',
    `background = "${lower(p.background)}"`,
    `foreground = "${lower(p.foreground)}"`,
    '',
    '[colors.cursor]',
    `cursor = "${cursor(p)}"`,
    `text = "${lower(p.background)}"`,
    '',
    '[colors.selection]',
    `background = "${selection(p)}"`,
    'text = "CellForeground"',
    '',
    '[colors.normal]',
    ...group(0),
    '',
    '[colors.bright]',
    ...group(8),
    '',
  ].join('\n');
}

function wezterm(p: TerminalPalette): string {
  const s = slots(p).map((hex) => `"${hex}"`);
  return [
    `# ${p.name} for WezTerm (${HEADER})`,
    '[colors]',
    `foreground = "${lower(p.foreground)}"`,
    `background = "${lower(p.background)}"`,
    `cursor_bg = "${cursor(p)}"`,
    `cursor_fg = "${lower(p.background)}"`,
    `cursor_border = "${cursor(p)}"`,
    `selection_bg = "${selection(p)}"`,
    `selection_fg = "${lower(p.foreground)}"`,
    `ansi = [${s.slice(0, 8).join(', ')}]`,
    `brights = [${s.slice(8).join(', ')}]`,
    '',
    '[metadata]',
    `name = "${p.name}"`,
    '',
  ].join('\n');
}

function iterm2(p: TerminalPalette): string {
  const entry = (key: string, hex: string): string[] => {
    const [r, g, b] = hexToRgb(hex).map((c) => String(c / 255));
    return [
      `\t<key>${key}</key>`,
      '\t<dict>',
      '\t\t<key>Alpha Component</key>', '\t\t<real>1</real>',
      '\t\t<key>Blue Component</key>', `\t\t<real>${b}</real>`,
      '\t\t<key>Color Space</key>', '\t\t<string>sRGB</string>',
      '\t\t<key>Green Component</key>', `\t\t<real>${g}</real>`,
      '\t\t<key>Red Component</key>', `\t\t<real>${r}</real>`,
      '\t</dict>',
    ];
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${p.name} for iTerm2 (${HEADER}) -->`,
    '<plist version="1.0">',
    '<dict>',
    ...slots(p).flatMap((hex, i) => entry(`Ansi ${i} Color`, hex)),
    ...entry('Background Color', p.background),
    ...entry('Foreground Color', p.foreground),
    ...entry('Bold Color', p.foreground),
    ...entry('Cursor Color', cursor(p)),
    ...entry('Cursor Text Color', p.background),
    ...entry('Selection Color', selection(p)),
    ...entry('Selected Text Color', p.foreground),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * macOS Terminal (round R1): a profile, not only colors. Its colors and its font are NSKeyedArchiver
 * archives inside the plist, as Terminal writes them; the font is Monaspace Argon at a comfortable
 * size (Terminal falls back to its default face when the font is not installed). Bold stays bold, not
 * brighter, so a slot keeps its measured color.
 */
function terminalApp(p: TerminalPalette): string {
  const color = (hex: string): Uint8Array => {
    const rgb = hexToRgb(hex).map((c) => String(Number((c / 255).toFixed(10)))).join(' ');
    return keyedArchive([{ NSColorSpace: 1, NSRGB: new TextEncoder().encode(`${rgb}\0`), $class: new Uid(2) }, { $classname: 'NSColor', $classes: ['NSColor', 'NSObject'] }]);
  };
  const font = keyedArchive([{ NSName: new Uid(2), NSSize: new Real(TYPE.terminalSize), NSfFlags: 16, $class: new Uid(3) }, TYPE.postscript, { $classname: 'NSFont', $classes: ['NSFont', 'NSObject'] }]);
  const ansi = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];
  const keys: Array<[string, string]> = [
    ...ansi.map((n, i): [string, string] => [`ANSI${n}Color`, p[SLOT_NAMES[i]]]),
    ...ansi.map((n, i): [string, string] => [`ANSIBright${n}Color`, p[SLOT_NAMES[i + 8]]]),
    ['BackgroundColor', p.background],
    ['TextColor', p.foreground],
    ['TextBoldColor', p.brightWhite],
    ['CursorColor', cursor(p)],
    ['SelectionColor', selection(p)],
  ];
  const data = (bytes: Uint8Array): string[] => ['\t<data>', ...(Buffer.from(bytes).toString('base64').match(/.{1,68}/g) ?? []).map((l) => `\t${l}`), '\t</data>'];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${p.name} for macOS Terminal (${HEADER}) -->`,
    '<plist version="1.0">',
    '<dict>',
    ...keys.flatMap(([key, hex]) => [`\t<key>${key}</key>`, ...data(color(hex))]),
    '\t<key>Font</key>', ...data(font),
    '\t<key>FontAntialias</key>', '\t<true/>',
    '\t<key>ProfileCurrentVersion</key>', '\t<real>2.09</real>',
    '\t<key>UseBrightBold</key>', '\t<false/>',
    '\t<key>columnCount</key>', '\t<integer>120</integer>',
    '\t<key>name</key>', `\t<string>${p.name}</string>`,
    '\t<key>rowCount</key>', '\t<integer>32</integer>',
    '\t<key>type</key>', '\t<string>Window Settings</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// zellij themes in the component format (zellij 0.42 or later): every part of zellij's own UI is set
// explicitly, so the selected tab stands out (ink on the tinted ribbon vs. ground on ink) and green,
// which means proof in Timmy, is never used. Text parts read at 7:1 or better; frames at 3:1.
function zellij(): string {
  const rgb = (hex: string): string => hexToRgb(hex).join(' ');
  const theme = (p: TerminalPalette): string[] => {
    const ink = p.foreground.toUpperCase();
    const ground = p.background.toUpperCase();
    // Unselected tabs are pills of ink mixed into the ground, with ground-colored text, as zellij's
    // own themes do: its compact bar draws the swap-layout label (BASE) in the ground color on the
    // unselected pill once a floating pane changes the layout (C-24; a dark pill made it 1.2:1).
    // Every second unselected tab takes ribbon_unselected's emphasis_1 (a C-18 probe): a stronger
    // mix keeps neighbours apart. The selected tab is ink. Text on every pill reads at 7:1 or
    // better, and the selected pill differs from the others by 2.5:1 or more: on a dark ground the
    // pills are 60% and 62% ink, on a light one 70% and 71% (the narrow band where both hold).
    const light = isLight(hexToRgb(ground));
    const pill = rgbToHex(blend(hexToRgb(ink), hexToRgb(ground), light ? 0.7 : 0.6));
    const altPill = rgbToHex(blend(hexToRgb(ink), hexToRgb(ground), light ? 0.71 : 0.62));
    const border = rgbToHex(blend(hexToRgb(ink), hexToRgb(ground), 0.5));
    const part = (name: string, base: string, background: string, emphasis1 = base): string[] => [
      `        ${name} {`,
      `            base ${rgb(base)}`,
      `            background ${rgb(background)}`,
      ...[0, 1, 2, 3].map((n) => `            emphasis_${n} ${rgb(n === 1 ? emphasis1 : base)}`),
      '        }',
    ];
    const players = [ink, p.blue, p.magenta, p.yellow, p.red, p.cyan, ink, p.blue, p.magenta, p.yellow];
    return [
      `    ${fileStem(p)} {`,
      ...part('text_unselected', ink, ground),
      ...part('text_selected', ground, ink),
      ...part('ribbon_unselected', ground, pill, altPill),
      ...part('ribbon_selected', ground, ink),
      ...part('table_title', ink, ground),
      ...part('table_cell_unselected', ink, ground),
      ...part('table_cell_selected', ground, ink),
      ...part('list_unselected', ink, ground),
      ...part('list_selected', ground, ink),
      ...part('frame_unselected', border, ground),
      ...part('frame_selected', ink, ground),
      ...part('frame_highlight', p.yellow, ground),
      ...part('exit_code_success', ink, ground),
      ...part('exit_code_error', p.red, ground),
      '        multiplayer_user_colors {',
      ...players.map((c, i) => `            player_${i + 1} ${rgb(c)}`),
      '        }',
      '    }',
    ];
  };
  return [
    `// Timmy Night and Day for zellij (${HEADER})`,
    '// Component format (zellij 0.42 or later). Green is never used: in Timmy, green means proof.',
    'themes {',
    ...theme(TIMMY_NIGHT),
    ...theme(TIMMY_DAY),
    '}',
    '',
  ].join('\n');
}

export function themeFiles(): Record<string, string> {
  const files: Record<string, string> = { 'zellij/timmy.kdl': zellij() };
  // Round R1: Timmy Homebrew, the default, beside Night and Day; macOS Terminal gets it as a profile.
  files[`terminal/${TIMMY_HOMEBREW.name}.terminal`] = terminalApp(TIMMY_HOMEBREW);
  for (const p of [TIMMY_HOMEBREW, TIMMY_NIGHT, TIMMY_DAY]) {
    const stem = fileStem(p);
    files[`ghostty/${stem}`] = ghostty(p);
    files[`kitty/${stem}.conf`] = kitty(p);
    files[`alacritty/${stem}.toml`] = alacritty(p);
    files[`wezterm/${p.name}.toml`] = wezterm(p);
    files[`iterm2/${p.name}.itermcolors`] = iterm2(p);
  }
  return files;
}
