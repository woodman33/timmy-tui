/**
 * B2 at the monitor's output (C-11, CHECKPOINTS row 28). The full-screen monitor is written in the
 * law's colors (lanes/visual/tokens.json, held by tests/design-contract), and its frames reach the
 * terminal as the palette's 16 colors, so Timmy Night, Timmy Day or any other theme draws them.
 * Each law color stands for one role of the semantic map (./theme.ts): white is the terminal's own
 * text color, grey-3 the measured secondary (B3), grey-2 the rule, and the four meanings their slots.
 * No ground or surface is painted: every law background becomes the terminal's own (49).
 */
import type { Role } from './theme.js';

/** The role each law color stands for when it is a text color. */
export const LAW_ROLES: Readonly<Record<string, Role>> = {
  white: 'primary', black: 'primary', 'grey-1': 'primary',
  'grey-3': 'secondary', 'grey-2': 'rule',
  seal: 'verified', 'seal-dim': 'verified', refuse: 'failure', predict: 'estimate', generated: 'ai',
};

const fgCode = (slot: number | null): string => (slot === null ? '39' : String(slot < 8 ? 30 + slot : 90 + slot - 8));
const rgbKey = (hex: string): string => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';');

/**
 * A function that rewrites every 24-bit SGR color that is a law color into its palette code; other
 * sequences, other colors and every other byte pass unchanged. `law` is name to #RRGGBB.
 */
export function lawPalette(law: Readonly<Record<string, string>>, slots: Readonly<Record<Role, number | null>>): (text: string) => string {
  const fg = new Map<string, string>();
  const bg = new Set<string>();
  for (const [name, hex] of Object.entries(law)) {
    const key = rgbKey(hex);
    fg.set(key, fgCode(slots[LAW_ROLES[name] ?? 'primary']));
    bg.add(key);
  }
  const rewrite = (params: string): string => {
    const p = params.split(';');
    const out: string[] = [];
    for (let i = 0; i < p.length; i++) {
      if ((p[i] === '38' || p[i] === '48') && p[i + 1] === '2' && i + 4 < p.length) {
        const key = p.slice(i + 2, i + 5).map(Number).join(';');
        const mapped = p[i] === '38' ? fg.get(key) : bg.has(key) ? '49' : undefined;
        out.push(...(mapped ? [mapped] : p.slice(i, i + 5)));
        i += 4;
      } else out.push(p[i]);
    }
    return out.join(';');
  };
  return (text) => (text.includes('\x1b[') ? text.replace(/\x1b\[([0-9;]*)m/g, (_m, params: string) => `\x1b[${rewrite(params)}m`) : text);
}
