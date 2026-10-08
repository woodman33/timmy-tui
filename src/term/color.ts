/** #RRGGBB colors and the WCAG 2.x contrast formula, shared by the theme and the contrast gate. */
export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const byte = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase();
export const rgbToHex = ([r, g, b]: Rgb): string => `#${byte(r)}${byte(g)}${byte(b)}`;

const linear = (channel: number): number => {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` laid over `bg` at opacity `alpha` (playbook §17.3 tint math). */
export const blend = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as Rgb;

/** The playbook's luminance test for choosing a tint direction. */
export const isLight = ([r, g, b]: Rgb): boolean => 0.299 * r + 0.587 * g + 0.114 * b > 128;
