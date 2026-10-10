/**
 * Timmy VoxVision (round R4, helper H49): an SVG of a mesh's (or a STEP's) axis-aligned bounding box with its measured
 * dimensions, drawn in plain TypeScript from the numbers a reader measured, and nothing else. Each box is drawn from
 * its minimum corner in an oblique view (x to the right, z up, y receding at 30°, half depth), all boxes at one scale,
 * so two boxes of a /compare read against each other. The dimensions are written as measured (seven significant
 * digits); the unit is the reader's (STL records none). DOCTRINE §15 goes in the drawing's description.
 */
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import { DOCTRINE_15, num } from './record.js';

export interface SvgBox {
  /** the legend's words: "a: refs/cube.stl" */
  label: string;
  /** the measured size on x, y and z */
  size: [number, number, number];
  colour?: string;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const f = (n: number): string => String(Math.round(n * 100) / 100);

const W = 560;
const H = 400;
const COS = Math.cos(Math.PI / 6) * 0.5;
const SIN = Math.sin(Math.PI / 6) * 0.5;

/** The SVG text of the boxes. Sizes that are not finite and non-negative are refused (nothing is drawn from them). */
export function bboxSvg(o: { title: string; boxes: SvgBox[]; unit: string; measuredBy: string }): string {
  const boxes = o.boxes.filter((b) => b.size.every((v) => Number.isFinite(v) && v >= 0));
  if (!boxes.length || boxes.length !== o.boxes.length) throw new Error('a bounding box needs three finite, non-negative sizes');
  const colours = [HOMEBREW.accent, HOMEBREW.link, HOMEBREW.attention];
  // The extent of every box in the drawing's own units, then one scale for all.
  const wide = Math.max(...boxes.map((b) => b.size[0] + b.size[1] * COS));
  const tall = Math.max(...boxes.map((b) => b.size[2] + b.size[1] * SIN));
  const legend = 22 + boxes.length * 18;
  const top = 70;
  const room = { w: W - 150, h: H - legend - 34 - top };
  const s = Math.min(wide > 0 ? room.w / wide : Infinity, tall > 0 ? room.h / tall : Infinity);
  const scale = Number.isFinite(s) ? s : 1;
  const ox = 70;
  const oy = H - legend - 34;
  const at = (x: number, y: number, z: number): [number, number] => [ox + (x + y * COS) * scale, oy - (z + y * SIN) * scale];
  const parts: string[] = [];
  boxes.forEach((b, i) => {
    const c = b.colour ?? colours[i % colours.length];
    const [x, y, z] = b.size;
    const p = {
      o: at(0, 0, 0), x: at(x, 0, 0), y: at(0, y, 0), z: at(0, 0, z), xy: at(x, y, 0), xz: at(x, 0, z), yz: at(0, y, z), xyz: at(x, y, z),
    };
    const line = (a: [number, number], d: [number, number], dashed = false): string => `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(d[0])}" y2="${f(d[1])}" stroke="${c}" stroke-width="${dashed ? 1.5 : 3}"${dashed ? ' stroke-dasharray="4 4" stroke-opacity="0.6"' : ''}/>`;
    // The three edges hidden behind the box, dashed; the nine others solid.
    parts.push(line(p.o, p.y, true), line(p.y, p.xy, true), line(p.y, p.yz, true));
    parts.push(line(p.o, p.x), line(p.x, p.xy), line(p.o, p.z), line(p.x, p.xz), line(p.z, p.xz), line(p.z, p.yz), line(p.xz, p.xyz), line(p.yz, p.xyz), line(p.xy, p.xyz));
    // Dimensions on the first box's own edges; every box's in the legend.
    if (i === 0) {
      const mid = (a: [number, number], d: [number, number]): [number, number] => [(a[0] + d[0]) / 2, (a[1] + d[1]) / 2];
      const [mx, my] = mid(p.o, p.x);
      const [vx, vy] = mid(p.o, p.z);
      const [dx, dy] = mid(p.x, p.xy);
      parts.push(`<text x="${f(mx)}" y="${f(my + 18)}" text-anchor="middle" fill="${c}">x ${esc(num(x))}</text>`);
      parts.push(`<text x="${f(vx - 8)}" y="${f(vy)}" text-anchor="end" fill="${c}">z ${esc(num(z))}</text>`);
      parts.push(`<text x="${f(dx + 8)}" y="${f(dy + 12)}" fill="${c}">y ${esc(num(y))}</text>`);
    }
    parts.push(`<text x="16" y="${f(H - legend + 6 + i * 18)}" fill="${c}">${esc(`${b.label}: ${num(x)} × ${num(y)} × ${num(z)} ${o.unit}`)}</text>`);
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family=${JSON.stringify(TYPE.stack.replace(/"/g, "'"))} font-size="15">`,
    `<title>${esc(o.title)}</title>`,
    `<desc>${esc(`Axis-aligned bounding box${boxes.length > 1 ? 'es' : ''} as measured by ${o.measuredBy}; drawn from those numbers only. ${DOCTRINE_15}`)}</desc>`,
    `<rect width="${W}" height="${H}" fill="${HOMEBREW.surface}"/>`,
    `<text x="16" y="24" fill="${HOMEBREW.text}" font-weight="600" font-size="16">${esc(o.title)}</text>`,
    `<text x="16" y="42" fill="${HOMEBREW.textSecondary}" font-size="11">${esc(`bounding box, ${o.unit}; measured by ${o.measuredBy}`)}</text>`,
    ...parts,
    `<text x="16" y="${H - 10}" fill="${HOMEBREW.textSecondary}" font-size="10">${esc('A measurement of the file, not of a physical part (DOCTRINE §15).')}</text>`,
    '</svg>',
    '',
  ].join('\n');
}
