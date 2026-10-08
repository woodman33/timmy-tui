/**
 * Terminal palettes: the default colors and the 16 ANSI slots. Timmy Night and Day are where the
 * brand lives (DESIGN.md §10 B2); Timmy itself only emits slot numbers. assets/themes is generated
 * from this file (scripts/ui/themes.ts).
 */
export const SLOT_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/** A terminal theme: default colors, the 16 ANSI slots, and whether bold also brightens slots 0-7. */
export type TerminalPalette = {
  readonly name: string;
  readonly background: string;
  readonly foreground: string;
  readonly boldIsBright?: boolean;
  readonly cursor?: string;
  readonly selection?: string;
} & { readonly [K in SlotName]: string };

/** Timmy Night: black void, white ink, the four meaning colors in their ANSI slots. */
export const TIMMY_NIGHT: TerminalPalette = {
  name: 'Timmy Night', background: '#000000', foreground: '#FFFFFF', cursor: '#FFFFFF', selection: '#3A3A3A',
  black: '#1A1A1A', red: '#FF3B3B', green: '#33FF66', yellow: '#FFB020',
  blue: '#6CA0FF', magenta: '#8B5CF6', cyan: '#5FD7FF', white: '#D0D0D0',
  brightBlack: '#6C6C6C', brightRed: '#FF6B6B', brightGreen: '#5FFF87', brightYellow: '#FFC857',
  brightBlue: '#9CC2FF', brightMagenta: '#A78BFA', brightCyan: '#8BE9FF', brightWhite: '#FFFFFF',
};

/** Timmy Day: the same roles on white, each accent darkened to hold contrast. */
export const TIMMY_DAY: TerminalPalette = {
  name: 'Timmy Day', background: '#FFFFFF', foreground: '#111111', cursor: '#111111', selection: '#D9D9D9',
  black: '#111111', red: '#C8102E', green: '#0B7A3B', yellow: '#8A5A00',
  blue: '#1F4FBF', magenta: '#6D28D9', cyan: '#0E6E86', white: '#E5E5E5',
  brightBlack: '#595959', brightRed: '#A50E25', brightGreen: '#08602E', brightYellow: '#6E4800',
  brightBlue: '#183E96', brightMagenta: '#5B21B6', brightCyan: '#0B5567', brightWhite: '#FFFFFF',
};

/** A stock theme for checks: macOS Terminal "Basic" as commonly published (white ground). */
export const TERMINAL_BASIC: TerminalPalette = {
  name: 'macOS Terminal Basic', background: '#FFFFFF', foreground: '#000000',
  black: '#000000', red: '#990000', green: '#00A600', yellow: '#999900',
  blue: '#0000B2', magenta: '#B200B2', cyan: '#00A6B2', white: '#BFBFBF',
  brightBlack: '#666666', brightRed: '#E50000', brightGreen: '#00D900', brightYellow: '#E5E500',
  brightBlue: '#0000FF', brightMagenta: '#E500E5', brightCyan: '#00E5E5', brightWhite: '#E5E5E5',
};

/**
 * A stock theme for checks: macOS Terminal "Clear Dark", the default profile on the operator's Mac, as
 * Terminal 2.15 (macOS 26) answered OSC 10, 11 and 4 on 2026-10-07. Its red (3.1:1) misses the text
 * floor on its own ground; its bright red (4.6:1) clears it. (Basic, above, answered within one step
 * of each published value.)
 */
export const TERMINAL_CLEAR_DARK: TerminalPalette = {
  name: 'macOS Terminal Clear Dark', background: '#212733', foreground: '#E6E6E6',
  black: '#35424B', red: '#B45547', green: '#6CAA71', yellow: '#C4AC62',
  blue: '#6D96B4', magenta: '#BD7BCD', cyan: '#7CCBCE', white: '#DEE6EC',
  brightBlack: '#465C6D', brightRed: '#E06C5A', brightGreen: '#79BE7E', brightYellow: '#E5C872',
  brightBlue: '#67B5ED', brightMagenta: '#D389E5', brightCyan: '#84DEE1', brightWhite: '#E6EFF6',
};

/** What Timmy measured (or was told) about the terminal: the ground and any palette slots. */
export interface MeasuredColors {
  background: string | null;
  slots: Partial<Record<number, string>>;
}

export const measuredFromPalette = (p: TerminalPalette): MeasuredColors => ({
  background: p.background.toUpperCase(),
  slots: Object.fromEntries(SLOT_NAMES.map((name, i) => [i, p[name].toUpperCase()])),
});

/** `TIMMY_PALETTE=night|day`: the operator says which palette is installed, so Timmy need not ask. */
export function namedPalette(name: string | undefined): TerminalPalette | undefined {
  return { night: TIMMY_NIGHT, day: TIMMY_DAY }[(name ?? '').toLowerCase()];
}
