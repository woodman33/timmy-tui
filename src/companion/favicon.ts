/**
 * R4 (H104, r25's D11): the browser companion's icon. The page declared none, so Chrome asked for /favicon.ico and the
 * companion answered 404: the one error in the page's console. Now the page declares this icon, a small SVG the companion
 * serves itself (nothing from another site): a prompt in Timmy Homebrew's colours (src/theme/tokens.ts), the green mark on
 * the charcoal surface. /favicon.ico answers with the same icon for a browser that asks for it anyway.
 */
import { HOMEBREW } from '../theme/tokens.js';

/** Where the page names its icon; /favicon.ico answers with it too. */
export const FAVICON_PATHS = Object.freeze(['/favicon.svg', '/favicon.ico']);

/** The icon: a rounded charcoal square, a green ">" and a green underscore (a terminal prompt), drawn at any size. */
export function faviconSvg(): string {
  const mark = `stroke="${HOMEBREW.accent}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">',
    `<rect x="1" y="1" width="30" height="30" rx="7" fill="${HOMEBREW.surface}" stroke="${HOMEBREW.lineStrong}" stroke-width="1"/>`,
    `<path d="M8.5 10.5 L14.5 16 L8.5 21.5" ${mark}/>`,
    `<path d="M17 22 H24" ${mark}/>`,
    '</svg>',
    '',
  ].join('\n');
}
