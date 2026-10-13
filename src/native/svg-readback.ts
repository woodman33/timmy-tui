/**
 * R4 (H64): Timmy's own reading of an SVG file, independent of the program that wrote it (Adobe Illustrator's export, for
 * /illustrator: src/native/illustrator.ts compares this reading with Illustrator's own report). It says:
 *   - the root's size: its viewBox, and width and height as written (each number with the digits it was written with);
 *   - how many shapes it draws, by element: path, rect, circle, ellipse, line, polyline, polygon (shapes inside a
 *     definition, such as <defs> or <clipPath>, draw nothing by themselves and are counted apart; so are hidden ones);
 *   - the characters of each drawn <text> element (its <tspan>s joined), and how many there are;
 *   - when they can be computed without a renderer, the bounds of the drawn shapes' geometry in the root's user units:
 *     no stroke, no text (a text's extent needs its font), each shape's own transforms applied; with the precision the
 *     file was written at (given by the caller), how far each side may be off from what its writer held.
 *
 * It reads the file as plain text, in one pass over it, with no backtracking: nothing in it is run, loaded, fetched or
 * expanded. Only XML's five named entities and character references are decoded; an entity a DOCTYPE declares is never
 * expanded (it stays as written, and a note says so), so an entity bomb costs nothing. A <script> is named in the notes,
 * never run, and its text is not read. CSS in a <style> element is not evaluated: a class that hides an element is not
 * seen (display or visibility in an element's own attributes or style attribute is). Anything that is not well-formed
 * XML is refused with where and why, rather than guessed at; so is a file past the limits below.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

export type SvgShape = 'path' | 'rect' | 'circle' | 'ellipse' | 'line' | 'polyline' | 'polygon';
export const SVG_SHAPES: readonly SvgShape[] = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'];
const SHAPE_SET: ReadonlySet<string> = new Set(SVG_SHAPES);
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** What one reading takes on at most: past any of these, the file is refused (or its bounds are not computed). */
export const SVG_READ_LIMITS = {
  bytes: 32 * 1024 * 1024, elements: 200_000, depth: 256, numbers: 4_000_000, texts: 1000, textChars: 10_000, notes: 24, reference: 64,
} as const;

/** [minX, minY, maxX, maxY] (bounds) or [minX, minY, width, height] (a viewBox), as each field says. */
export type Box4 = [number, number, number, number];
/** A length as written: its number, its unit ('' when none), the text, and the digits after the point it was written with. */
export interface SvgLength { value: number; unit: string; raw: string; decimals: number }
export interface SvgBounds {
  /** [minX, minY, maxX, maxY] of the drawn shapes' geometry, in the root's user units; null when none is drawn or not computed */
  box: Box4 | null;
  computed: boolean;
  /** why the bounds were not computed */
  why?: string;
  /** how far each side may be off, from the precision the file was written at; null when that precision was not given */
  tolerance: number | null;
}
export interface SvgReading {
  ok: true;
  /** the root's viewBox, [minX, minY, width, height], and the digits after the point each number was written with */
  viewBox?: { box: Box4; decimals: Box4 };
  width?: SvgLength;
  height?: SvgLength;
  /** the root declares SVG's namespace */
  namespace: boolean;
  /** the shapes it draws, by element */
  shapes: Record<SvgShape, number>;
  shapeTotal: number;
  /** shapes and texts inside a definition (defs, clipPath, mask, pattern, symbol, marker...): they draw nothing by themselves */
  defined: number;
  /** shapes and texts with display none or visibility hidden (on them or above them) */
  hidden: number;
  /** each drawn <text>'s characters, runs of white space made one space, in document order (the first 1,000) */
  texts: string[];
  textTotal: number;
  images: number;
  uses: number;
  elements: number;
  bounds: SvgBounds;
  notes: string[];
}
export type SvgRead = SvgReading | { ok: false; why: string };

// ── small readers, each linear in its input ────────────────────────────────────

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isNameStart = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x3a || c >= 0x80;
const isNameChar = (c: number): boolean => isNameStart(c) || isDigit(c) || c === 0x2d || c === 0x2e;

/** A number scanner over a string (path data, points, viewBox, transforms, lengths): SVG's number grammar. */
class Numbers {
  i = 0;
  constructor(readonly s: string, readonly budget: { left: number }) {}
  /** Skips white space and at most one comma (between numbers). */
  sep(): void {
    const s = this.s;
    while (this.i < s.length && isSpace(s.charCodeAt(this.i))) this.i++;
    if (s.charCodeAt(this.i) === 0x2c) {
      this.i++;
      while (this.i < s.length && isSpace(s.charCodeAt(this.i))) this.i++;
    }
  }
  space(): void { while (this.i < this.s.length && isSpace(this.s.charCodeAt(this.i))) this.i++; }
  done(): boolean { return this.i >= this.s.length; }
  /** The next number, or undefined (nothing consumed) when none starts here; decimals: digits after the point less the exponent. */
  number(): { value: number; decimals: number } | undefined {
    const s = this.s;
    let i = this.i;
    const start = i;
    if (s[i] === '+' || s[i] === '-') i++;
    let int = 0;
    while (i < s.length && isDigit(s.charCodeAt(i))) { i++; int++; }
    let frac = 0;
    if (s[i] === '.') {
      const at = i;
      i++;
      while (i < s.length && isDigit(s.charCodeAt(i))) { i++; frac++; }
      if (!int && !frac) { i = at; }
    }
    if (!int && !frac) return undefined;
    let exp = 0;
    if (s[i] === 'e' || s[i] === 'E') {
      let j = i + 1;
      if (s[j] === '+' || s[j] === '-') j++;
      const digits = j;
      while (j < s.length && isDigit(s.charCodeAt(j))) j++;
      if (j > digits) {
        exp = Number(s.slice(i + 1, j));
        i = j;
      }
    }
    if (--this.budget.left < 0) return undefined;
    this.i = i;
    const value = Number(s.slice(start, i));
    return { value, decimals: Number.isFinite(exp) ? frac - exp : frac };
  }
  /** An arc flag: one character, 0 or 1, needing no separator. */
  flag(): 0 | 1 | undefined {
    const c = this.s[this.i];
    if (c === '0' || c === '1') { this.i++; return c === '1' ? 1 : 0; }
    return undefined;
  }
}

const DIGITS_BUDGET = (): { left: number } => ({ left: SVG_READ_LIMITS.numbers });

/** One number standing alone (a length's number), with its unit: undefined when it is not one. */
export function parseLength(raw: string): SvgLength | undefined {
  const t = raw.trim();
  if (!t || t.length > 200) return undefined;
  const sc = new Numbers(t, DIGITS_BUDGET());
  const n = sc.number();
  if (!n) return undefined;
  const unit = t.slice(sc.i).trim();
  if (!/^(?:|px|pt|pc|mm|cm|in|em|ex|%)$/i.test(unit)) return undefined;
  return { value: n.value, unit: unit.toLowerCase(), raw: t, decimals: n.decimals };
}

/** A list of numbers (a viewBox, points): undefined when anything else is in it. */
function numberList(raw: string, budget: { left: number }): Array<{ value: number; decimals: number }> | undefined {
  const sc = new Numbers(raw, budget);
  const out: Array<{ value: number; decimals: number }> = [];
  sc.space();
  while (!sc.done()) {
    const n = sc.number();
    if (!n) return undefined;
    out.push(n);
    sc.sep();
  }
  return out;
}

/** An affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
function times(m: Mat, n: Mat): Mat {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

/** A transform attribute: matrix, translate, scale, rotate, skewX, skewY, composed left to right; or why it cannot be read. */
export function parseTransform(raw: string): Mat | { why: string } {
  const s = raw;
  let i = 0;
  let m: Mat = IDENTITY;
  const budget = DIGITS_BUDGET();
  if (s.length > 100_000) return { why: 'a transform longer than 100,000 characters' };
  for (;;) {
    while (i < s.length && (isSpace(s.charCodeAt(i)) || s[i] === ',')) i++;
    if (i >= s.length) return m;
    const nameStart = i;
    while (i < s.length && /[A-Za-z]/.test(s[i])) i++;
    const name = s.slice(nameStart, i);
    while (i < s.length && isSpace(s.charCodeAt(i))) i++;
    if (s[i] !== '(') return { why: `a transform that could not be read (${name || 'no name'} without "(")` };
    const close = s.indexOf(')', i + 1);
    if (close < 0) return { why: `a transform that could not be read (${name} without ")")` };
    const args = numberList(s.slice(i + 1, close), budget);
    if (!args) return { why: `a transform that could not be read (${name}'s numbers)` };
    const v = args.map((a) => a.value);
    const k = v.length;
    const rad = (deg: number): number => (deg * Math.PI) / 180;
    let t: Mat;
    if (name === 'matrix' && k === 6) t = [v[0], v[1], v[2], v[3], v[4], v[5]];
    else if (name === 'translate' && (k === 1 || k === 2)) t = [1, 0, 0, 1, v[0], k === 2 ? v[1] : 0];
    else if (name === 'scale' && (k === 1 || k === 2)) t = [v[0], 0, 0, k === 2 ? v[1] : v[0], 0, 0];
    else if (name === 'rotate' && (k === 1 || k === 3)) {
      const c = Math.cos(rad(v[0]));
      const sn = Math.sin(rad(v[0]));
      const r: Mat = [c, sn, -sn, c, 0, 0];
      t = k === 3 ? times(times([1, 0, 0, 1, v[1], v[2]], r), [1, 0, 0, 1, -v[1], -v[2]]) : r;
    } else if (name === 'skewX' && k === 1) t = [1, 0, Math.tan(rad(v[0])), 1, 0, 0];
    else if (name === 'skewY' && k === 1) t = [1, Math.tan(rad(v[0])), 0, 1, 0, 0];
    else return { why: `a transform that could not be read (${name || 'no name'} with ${k} number${k === 1 ? '' : 's'})` };
    m = times(m, t);
    i = close + 1;
  }
}

/** The display and visibility a style attribute sets (the only properties read from it), lowercased. */
function styleOf(raw: string | undefined): { display?: string; visibility?: string } {
  if (!raw) return {};
  const out: { display?: string; visibility?: string } = {};
  for (const decl of raw.slice(0, 100_000).split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).replace(/!\s*important/i, '').trim().toLowerCase();
    if (prop === 'display') out.display = value;
    if (prop === 'visibility') out.visibility = value;
  }
  return out;
}

// ── the bounds of what is drawn ──────────────────────────────────────────────────

/**
 * The drawn geometry's box, and how far each side can be from what the writer held: every point is known only to within its
 * error e, so a side (the least x, say) lies between the least of x - e and the least of x + e; its tolerance is how far
 * either end is from the side as read. Interval arithmetic, side by side, not the largest error of any point.
 */
class Bounds {
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  /** the least and greatest of x - e and x + e, and of y - e and y + e */
  private readonly lo = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  private readonly hi = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  why: string | undefined;
  any = false;
  constructor(readonly eps: number) {}
  fail(why: string): void { if (!this.why) this.why = why; }
  add(x: number, y: number, e: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(e)) { this.fail('a coordinate that is not a finite number'); return; }
    this.any = true;
    if (x < this.x0) this.x0 = x;
    if (y < this.y0) this.y0 = y;
    if (x > this.x1) this.x1 = x;
    if (y > this.y1) this.y1 = y;
    this.lo.x0 = Math.min(this.lo.x0, x - e);
    this.hi.x0 = Math.min(this.hi.x0, x + e);
    this.lo.y0 = Math.min(this.lo.y0, y - e);
    this.hi.y0 = Math.min(this.hi.y0, y + e);
    this.lo.x1 = Math.max(this.lo.x1, x - e);
    this.hi.x1 = Math.max(this.hi.x1, x + e);
    this.lo.y1 = Math.max(this.lo.y1, y - e);
    this.hi.y1 = Math.max(this.hi.y1, y + e);
  }
  /** The largest of the four sides' tolerances (0 when nothing was added). */
  get err(): number {
    if (!this.any) return 0;
    const { lo, hi } = this;
    return Math.max(this.x0 - lo.x0, hi.x0 - this.x0, this.y0 - lo.y0, hi.y0 - this.y0, this.x1 - lo.x1, hi.x1 - this.x1, this.y1 - lo.y1, hi.y1 - this.y1);
  }
}

/**
 * A point through the transforms that lead to the root (innermost first), with how far it may be off: each transform's
 * numbers are taken as written at the file's precision (eps each), so a point (x, y) off by e becomes one off by
 * max(|a| + |c|, |b| + |d|) e + eps (|x| + |y| + 1). A bound on rounding, not a measurement of it.
 */
function through(x: number, y: number, e: number, mats: readonly Mat[], eps: number): [number, number, number] {
  for (let k = mats.length - 1; k >= 0; k--) {
    const [a, b, c, d, tx, ty] = mats[k];
    const nx = a * x + c * y + tx;
    const ny = b * x + d * y + ty;
    e = Math.max(Math.abs(a) + Math.abs(c), Math.abs(b) + Math.abs(d)) * e + eps * (Math.abs(x) + Math.abs(y) + 1);
    x = nx;
    y = ny;
  }
  return [x, y, e];
}

const compose = (mats: readonly Mat[]): Mat => mats.reduce((m, n) => times(m, n), IDENTITY);

/** Whether angle t lies on the sweep from t1 through dt (radians; dt negative sweeps the other way). */
function onSweep(t: number, t1: number, dt: number): boolean {
  const TAU = 2 * Math.PI;
  const mod = (v: number): number => ((v % TAU) + TAU) % TAU;
  if (Math.abs(dt) >= TAU - 1e-12) return true;
  return dt >= 0 ? mod(t - t1) <= dt + 1e-12 : mod(t1 - t) <= -dt + 1e-12;
}

/**
 * An elliptical arc (centre, radii, x-axis rotation phi in radians, start t1 and sweep dt) drawn through `mats`: its
 * extreme points (where the drawn x or y turns) that lie on the sweep. Its ends are added by the caller.
 */
function arcExtremes(b: Bounds, cx: number, cy: number, rx: number, ry: number, phi: number, t1: number, dt: number, e: number, mats: readonly Mat[]): void {
  const [a, bb, c, d] = compose(mats);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const g11 = a * rx * cp + c * rx * sp;
  const g12 = -a * ry * sp + c * ry * cp;
  const g21 = bb * rx * cp + d * rx * sp;
  const g22 = -bb * ry * sp + d * ry * cp;
  for (const t0 of [Math.atan2(g12, g11), Math.atan2(g22, g21)]) {
    for (const t of [t0, t0 + Math.PI]) {
      if (!onSweep(t, t1, dt)) continue;
      const ux = cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp;
      const uy = cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp;
      const [x, y, err] = through(ux, uy, e, mats, b.eps);
      b.add(x, y, err);
    }
  }
}

/** The roots in (0, 1) of p t^2 + q t + r = 0. */
function unitRoots(p: number, q: number, r: number): number[] {
  const out: number[] = [];
  const scale = Math.max(Math.abs(p), Math.abs(q), Math.abs(r));
  if (!(scale > 0)) return out;
  if (Math.abs(p) <= 1e-12 * scale) {
    if (Math.abs(q) > 1e-12 * scale) out.push(-r / q);
  } else {
    const disc = q * q - 4 * p * r;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      out.push((-q + sq) / (2 * p), (-q - sq) / (2 * p));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

type Pt = [number, number, number];

/** A cubic (four points, each through the transforms already, with its error): its turning points on each axis. */
function cubicExtremes(b: Bounds, p0: Pt, p1: Pt, p2: Pt, p3: Pt): void {
  const e = Math.max(p0[2], p1[2], p2[2], p3[2]);
  for (const axis of [0, 1] as const) {
    const A = p1[axis] - p0[axis];
    const B = p2[axis] - p1[axis];
    const C = p3[axis] - p2[axis];
    for (const t of unitRoots(A - 2 * B + C, 2 * (B - A), A)) {
      const u = 1 - t;
      const at = (k: 0 | 1): number => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k];
      b.add(at(0), at(1), e);
    }
  }
}

/** A quadratic (three points through the transforms, with errors): its turning points. */
function quadExtremes(b: Bounds, p0: Pt, p1: Pt, p2: Pt): void {
  const e = Math.max(p0[2], p1[2], p2[2]);
  for (const axis of [0, 1] as const) {
    const den = p0[axis] - 2 * p1[axis] + p2[axis];
    if (den === 0) continue;
    const t = (p0[axis] - p1[axis]) / den;
    if (!(t > 0 && t < 1)) continue;
    const u = 1 - t;
    const at = (k: 0 | 1): number => u * u * p0[k] + 2 * u * t * p1[k] + t * t * p2[k];
    b.add(at(0), at(1), e);
  }
}

/** A path's data, its geometry added to `b` through `mats`: why it could not be read, or undefined. */
function pathBounds(d: string, b: Bounds, mats: readonly Mat[], budget: { left: number }): string | undefined {
  const eps = b.eps;
  const sc = new Numbers(d, budget);
  const put = (x: number, y: number, e: number): Pt => { const p = through(x, y, e, mats, eps); return p; };
  let cmd = '';
  let cur: Pt = [0, 0, 0];
  let start: Pt = [0, 0, 0];
  let lastCubic: Pt | undefined; // the previous segment's second control point, in user space, when it was a cubic
  let lastQuad: Pt | undefined;
  let first = true;
  const OVER = `more than ${SVG_READ_LIMITS.numbers.toLocaleString('en-US')} numbers in path data`;
  const num = (): { value: number; decimals: number } | undefined => { sc.sep(); return budget.left > 0 ? sc.number() : undefined; };
  /** Why a command could not be read: the numbers ran out (the file's budget), or the data did. */
  const short = (what: string): string => (budget.left <= 0 ? OVER : `path data that ends inside ${what}`);
  const pair = (rel: boolean): Pt | undefined => {
    const x = num();
    if (!x) return undefined;
    const y = num();
    if (!y) return undefined;
    return rel ? [cur[0] + x.value, cur[1] + y.value, cur[2] + eps] : [x.value, y.value, eps];
  };
  const addUser = (p: Pt): Pt => { const t = put(p[0], p[1], p[2]); b.add(t[0], t[1], t[2]); return t; };
  for (;;) {
    sc.space();
    if (sc.done()) return undefined;
    const ch = d[sc.i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) { cmd = ch; sc.i++; } else if (!cmd || cmd === 'Z' || cmd === 'z') {
      return `path data that could not be read at character ${sc.i + 1}`;
    }
    if (first && cmd !== 'M' && cmd !== 'm') return 'path data that does not start with a move (M)';
    first = false;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      cur = start;
      lastCubic = undefined;
      lastQuad = undefined;
      continue;
    }
    if (C === 'M') {
      const p = pair(rel);
      if (!p) return short('a move');
      cur = p;
      start = p;
      addUser(p);
      lastCubic = undefined;
      lastQuad = undefined;
      cmd = rel ? 'l' : 'L'; // further pairs are lines
      continue;
    }
    if (C === 'L') {
      const p = pair(rel);
      if (!p) return short('a line');
      addUser(p);
      cur = p;
      lastCubic = undefined;
      lastQuad = undefined;
      continue;
    }
    if (C === 'H' || C === 'V') {
      const n = num();
      if (!n) return short('a line');
      const p: Pt = C === 'H' ? [rel ? cur[0] + n.value : n.value, cur[1], rel ? cur[2] + eps : Math.max(cur[2], eps)]
        : [cur[0], rel ? cur[1] + n.value : n.value, rel ? cur[2] + eps : Math.max(cur[2], eps)];
      addUser(p);
      cur = p;
      lastCubic = undefined;
      lastQuad = undefined;
      continue;
    }
    if (C === 'C' || C === 'S') {
      let c1: Pt | undefined;
      if (C === 'C') c1 = pair(rel);
      else c1 = lastCubic ? [2 * cur[0] - lastCubic[0], 2 * cur[1] - lastCubic[1], 2 * cur[2] + lastCubic[2]] : cur;
      const c2 = c1 ? pair(rel) : undefined;
      const end = c2 ? pair(rel) : undefined;
      if (!c1 || !c2 || !end) return short('a curve');
      const q0 = put(cur[0], cur[1], cur[2]);
      const q1 = put(c1[0], c1[1], c1[2]);
      const q2 = put(c2[0], c2[1], c2[2]);
      const q3 = addUser(end);
      cubicExtremes(b, q0, q1, q2, q3);
      lastCubic = c2;
      lastQuad = undefined;
      cur = end;
      continue;
    }
    if (C === 'Q' || C === 'T') {
      let c1: Pt | undefined;
      if (C === 'Q') c1 = pair(rel);
      else c1 = lastQuad ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1], 2 * cur[2] + lastQuad[2]] : cur;
      const end = c1 ? pair(rel) : undefined;
      if (!c1 || !end) return short('a curve');
      const q0 = put(cur[0], cur[1], cur[2]);
      const q1 = put(c1[0], c1[1], c1[2]);
      const q2 = addUser(end);
      quadExtremes(b, q0, q1, q2);
      lastQuad = c1;
      lastCubic = undefined;
      cur = end;
      continue;
    }
    // A: rx ry x-axis-rotation large-arc-flag sweep-flag x y
    const rxN = num();
    const ryN = rxN ? num() : undefined;
    const rotN = ryN ? num() : undefined;
    if (rotN) sc.sep();
    const large = rotN ? sc.flag() : undefined;
    if (large !== undefined) sc.sep();
    const sweep = large !== undefined ? sc.flag() : undefined;
    const end = sweep !== undefined ? pair(rel) : undefined;
    if (!rxN || !ryN || !rotN || large === undefined || sweep === undefined || !end) return short('an arc');
    addUser(end);
    arcSegment(b, cur, end, Math.abs(rxN.value), Math.abs(ryN.value), rotN.value, large, sweep, mats);
    lastCubic = undefined;
    lastQuad = undefined;
    cur = end;
  }
}

/** An arc segment of path data (SVG's endpoint form, radii scaled up when too small), its turning points added. */
function arcSegment(b: Bounds, p1: Pt, p2: Pt, rx0: number, ry0: number, rotDeg: number, large: 0 | 1, sweep: 0 | 1, mats: readonly Mat[]): void {
  if (p1[0] === p2[0] && p1[1] === p2[1]) return; // the same point: no arc
  if (rx0 === 0 || ry0 === 0) return; // a straight line: its ends are added already
  const phi = (rotDeg * Math.PI) / 180;
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const dx = (p1[0] - p2[0]) / 2;
  const dy = (p1[1] - p2[1]) / 2;
  const x1 = cp * dx + sp * dy;
  const y1 = -sp * dx + cp * dy;
  let rx = rx0;
  let ry = ry0;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { const k = Math.sqrt(lambda); rx *= k; ry *= k; }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, den > 0 ? num / den : 0));
  const cxp = (co * rx * y1) / ry;
  const cyp = (-co * ry * x1) / rx;
  const cx = cp * cxp - sp * cyp + (p1[0] + p2[0]) / 2;
  const cy = sp * cxp + cp * cyp + (p1[1] + p2[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  // Its radii and rotation are written at the file's precision too: an engineering bound, not derived for every case.
  const e = Math.max(p1[2], p2[2]) + b.eps * (2 + rx + ry);
  arcExtremes(b, cx, cy, rx, ry, phi, t1, dt, e, mats);
}

// ── the reader ───────────────────────────────────────────────────────────────────

/** The elements whose content draws nothing by itself. */
const DEFINITIONS: ReadonlySet<string> = new Set(['defs', 'clipPath', 'mask', 'pattern', 'symbol', 'marker', 'linearGradient', 'radialGradient', 'filter']);
/** The elements whose characters are not a text's. */
const NOT_TEXT: ReadonlySet<string> = new Set(['script', 'style', 'title', 'desc', 'metadata']);

interface TextAcc { parts: string[]; len: number; drawn: boolean }
interface Frame {
  name: string;
  local: string | null;
  foreign: boolean;
  defs: boolean;
  display: boolean;
  visible: boolean;
  mats: Mat[];
  matsWhy?: string;
  skip: boolean;
  text: TextAcc | null;
  ownsText: boolean;
}

class Notes {
  readonly list: string[] = [];
  private readonly seen = new Set<string>();
  add(note: string): void {
    if (this.seen.has(note) || this.list.length >= SVG_READ_LIMITS.notes) return;
    this.seen.add(note);
    this.list.push(note);
  }
}

class NotWellFormed extends Error {}

/** Where in the text an offset is, as "line L, column C". */
function where(s: string, at: number): string {
  let line = 1;
  let last = -1;
  for (let k = s.indexOf('\n'); k >= 0 && k < at; k = s.indexOf('\n', k + 1)) { line++; last = k; }
  return `line ${line}, column ${at - last}`;
}

/** XML's five named entities: the only ones decoded. */
const NAMED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Character data with XML's five named entities and character references decoded; another entity stays as written. */
function decode(s: string, notes: Notes): string {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  for (;;) {
    const amp = s.indexOf('&', i);
    if (amp < 0) return out + s.slice(i);
    out += s.slice(i, amp);
    const semi = s.indexOf(';', amp + 1);
    if (semi < 0 || semi - amp > SVG_READ_LIMITS.reference) throw new NotWellFormed('an & that does not start a reference');
    const ref = s.slice(amp + 1, semi);
    i = semi + 1;
    if (Object.hasOwn(NAMED, ref)) { out += NAMED[ref]; continue; }
    if (ref.startsWith('#')) {
      const hex = ref[1] === 'x';
      const digits = ref.slice(hex ? 2 : 1);
      if (!digits || !(hex ? /^[0-9A-Fa-f]+$/ : /^[0-9]+$/).test(digits)) throw new NotWellFormed(`a character reference that is not one (&${ref};)`);
      const cp = digits.length > 8 ? Infinity : parseInt(digits, hex ? 16 : 10);
      const allowed = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
      if (!allowed) { notes.add(`a character reference to a character XML does not allow (&${ref.slice(0, 12)};): read as U+FFFD`); out += '�'; continue; }
      out += String.fromCodePoint(cp);
      continue;
    }
    if (!/^[A-Za-z_:][-A-Za-z0-9._:]*$/.test(ref)) throw new NotWellFormed(`a reference that is not one (&${ref.slice(0, 20)};)`);
    notes.add(`an entity Timmy does not expand (&${ref};): kept as written`);
    out += `&${ref};`;
  }
}

/** The end of a DOCTYPE starting at `at` (its internal subset read for quotes and brackets), and whether it declares entities. */
function doctypeEnd(s: string, at: number): { end: number; entities: boolean } {
  let i = at + 9;
  let depth = 0;
  let quote = '';
  let entities = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === '<' && s.startsWith('<!ENTITY', i)) entities = true;
    else if (c === '>' && depth === 0) return { end: i + 1, entities };
  }
  throw new NotWellFormed('a DOCTYPE left open');
}

/**
 * Reads an SVG text (see the module's comment). `precision`: the decimals the file's coordinates were written with
 * (Illustrator's coordinatePrecision, say): each written coordinate is then off by at most half a unit in that place,
 * and the bounds say how far that can take each side. Without it, the bounds carry no tolerance.
 */
export function readSvgText(input: string, o: { precision?: number } = {}): SvgRead {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const eps = o.precision !== undefined && Number.isInteger(o.precision) && o.precision >= 0 && o.precision <= 15 ? 0.5 * 10 ** -o.precision : 0;
  const notes = new Notes();
  const bounds = new Bounds(eps);
  const budget = DIGITS_BUDGET();
  const shapes = Object.fromEntries(SVG_SHAPES.map((k) => [k, 0])) as Record<SvgShape, number>;
  const texts: string[] = [];
  const stack: Frame[] = [];
  const r = { shapeTotal: 0, defined: 0, hidden: 0, textTotal: 0, images: 0, uses: 0, elements: 0 };
  let rootSeen = false;
  let rootDone = false;
  let viewBox: SvgReading['viewBox'];
  let width: SvgLength | undefined;
  let height: SvgLength | undefined;
  let namespace = false;
  const n = s.length;
  let i = 0;

  const text = (chunk: string, raw: boolean): void => {
    const top = stack.at(-1);
    if (!top) {
      if (/\S/.test(chunk)) throw new NotWellFormed(`text outside the root element (at ${where(s, i)})`);
      return;
    }
    if (!raw && chunk.includes(']]>')) throw new NotWellFormed(`]]> in text (at ${where(s, i)})`);
    if (!raw && chunk.includes('&')) chunk = decode(chunk, notes);
    const acc = top.text;
    if (!acc || top.skip || top.foreign || acc.len >= SVG_READ_LIMITS.textChars) return;
    const piece = chunk.slice(0, SVG_READ_LIMITS.textChars - acc.len);
    acc.parts.push(piece);
    acc.len += piece.length;
  };

  const shapeGeometry = (local: SvgShape, a: Map<string, string>, f: Frame): void => {
    if (f.matsWhy) { bounds.fail(f.matsWhy); return; }
    const len = (k: string, dflt?: number): number | undefined => {
      const raw = a.get(k);
      if (raw === undefined) return dflt;
      const l = parseLength(raw);
      if (!l) { bounds.fail(`a ${k} that is not a length (${raw.slice(0, 40)})`); return undefined; }
      if (l.unit && l.unit !== 'px') { bounds.fail(`a ${k} in ${l.unit} (lengths in units other than px are not converted)`); return undefined; }
      return l.value;
    };
    const pt = (x: number, y: number, e: number): void => { const p = through(x, y, e, f.mats, eps); bounds.add(p[0], p[1], p[2]); };
    if (local === 'rect') {
      const x = len('x', 0);
      const y = len('y', 0);
      const w = len('width');
      const h = len('height');
      if (x === undefined || y === undefined || w === undefined || h === undefined) { if (w === undefined || h === undefined) bounds.fail('a rect without its width or height'); return; }
      if (!(w > 0) || !(h > 0)) return; // SVG draws nothing for a rect of no width or height
      for (const [px, py, e] of [[x, y, eps], [x + w, y, 2 * eps], [x, y + h, 2 * eps], [x + w, y + h, 2 * eps]] as const) pt(px, py, e);
      return;
    }
    if (local === 'circle' || local === 'ellipse') {
      const cx = len('cx', 0);
      const cy = len('cy', 0);
      let rx: number | undefined;
      let ry: number | undefined;
      if (local === 'circle') rx = ry = len('r');
      else {
        rx = a.get('rx') === undefined ? undefined : len('rx');
        ry = a.get('ry') === undefined ? undefined : len('ry');
        if (rx === undefined) rx = ry;
        if (ry === undefined) ry = rx;
      }
      if (cx === undefined || cy === undefined || rx === undefined || ry === undefined) { if (rx === undefined) bounds.fail(`a ${local} without its radius`); return; }
      if (!(rx > 0) || !(ry > 0)) return; // nothing is drawn
      arcExtremes(bounds, cx, cy, rx, ry, 0, 0, 2 * Math.PI, 2 * eps, f.mats);
      return;
    }
    if (local === 'line') {
      const x1 = len('x1', 0);
      const y1 = len('y1', 0);
      const x2 = len('x2', 0);
      const y2 = len('y2', 0);
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return;
      pt(x1, y1, eps);
      pt(x2, y2, eps);
      return;
    }
    if (local === 'polyline' || local === 'polygon') {
      const list = numberList(a.get('points') ?? '', budget);
      if (!list) { bounds.fail(budget.left < 0 ? `more than ${SVG_READ_LIMITS.numbers.toLocaleString('en-US')} numbers in its points` : `a ${local} whose points could not be read`); return; }
      if (list.length % 2) notes.add(`a ${local} with an odd number of coordinates: the last one is not a point`);
      for (let k = 0; k + 1 < list.length; k += 2) pt(list[k].value, list[k + 1].value, eps);
      return;
    }
    const d = a.get('d');
    if (d === undefined || !d.trim()) return; // SVG draws nothing for a path without data
    const why = pathBounds(d, bounds, f.mats, budget);
    if (why) bounds.fail(why);
  };

  const open = (name: string, a: Map<string, string>, selfClosing: boolean, at: number): void => {
    if (++r.elements > SVG_READ_LIMITS.elements) throw new NotWellFormed(`more than ${SVG_READ_LIMITS.elements.toLocaleString('en-US')} elements`);
    if (stack.length >= SVG_READ_LIMITS.depth) throw new NotWellFormed(`elements nested deeper than ${SVG_READ_LIMITS.depth}`);
    const parent = stack.at(-1);
    const local = name.includes(':') ? null : name;
    if (!parent) {
      if (rootDone) throw new NotWellFormed(`a second root element <${name}> (at ${where(s, at)})`);
      if (local !== 'svg') throw new NotWellFormed(`the root element is <${name}>, not <svg>`);
      rootSeen = true;
      namespace = a.get('xmlns') === SVG_NAMESPACE;
      if (!namespace) notes.add('the root does not declare SVG\'s namespace');
      const vb = a.get('viewBox');
      if (vb !== undefined) {
        const list = numberList(vb, budget);
        if (list && list.length === 4 && list.every((x) => Number.isFinite(x.value)) && list[2].value >= 0 && list[3].value >= 0) {
          viewBox = { box: [list[0].value, list[1].value, list[2].value, list[3].value], decimals: [list[0].decimals, list[1].decimals, list[2].decimals, list[3].decimals] };
        } else notes.add(`a viewBox that could not be read (${vb.slice(0, 60)})`);
      }
      const w = a.get('width');
      const h = a.get('height');
      if (w !== undefined) { width = parseLength(w); if (!width) notes.add(`a width that could not be read (${w.slice(0, 40)})`); }
      if (h !== undefined) { height = parseLength(h); if (!height) notes.add(`a height that could not be read (${h.slice(0, 40)})`); }
    }
    const style = styleOf(a.get('style'));
    const display = (parent ? parent.display : true) && (a.get('display')?.trim().toLowerCase() ?? style.display) !== 'none';
    const vis = (a.get('visibility')?.trim().toLowerCase() ?? style.visibility);
    const visible = vis === 'hidden' || vis === 'collapse' ? false : vis === 'visible' ? true : parent ? parent.visible : true;
    const foreign = parent ? parent.foreign || local === null || parent.local === 'foreignObject' : false;
    // Inside a definition, or inside an element whose content is never drawn (script, style, title, desc, metadata).
    const defs = (parent?.defs ?? false) || (local !== null && (DEFINITIONS.has(local) || NOT_TEXT.has(local)));
    let mats = parent?.mats ?? [];
    let matsWhy = parent?.matsWhy;
    const tf = a.get('transform');
    if (tf !== undefined && !foreign) {
      const m = parseTransform(tf);
      if ('why' in m) matsWhy ??= m.why; else mats = [...mats, m];
    }
    const skip = (parent?.skip ?? false) || (local !== null && NOT_TEXT.has(local));
    const drawn = !defs && display && visible && !foreign;
    let textAcc = parent?.text ?? null;
    let ownsText = false;
    if (!foreign && local === 'text' && !textAcc) {
      textAcc = { parts: [], len: 0, drawn };
      ownsText = true;
      if (defs) r.defined++; else if (!drawn) r.hidden++; else r.textTotal++;
    }
    const frame: Frame = { name, local, foreign, defs, display, visible, mats, ...(matsWhy ? { matsWhy } : {}), skip, text: textAcc, ownsText };
    if (local === null) notes.add(`elements in another namespace (<${name.slice(0, 40)}>) are not counted`);
    else if (!foreign) {
      if (SHAPE_SET.has(local)) {
        if (defs) r.defined++;
        else if (!display || !visible) r.hidden++;
        else {
          shapes[local as SvgShape]++;
          r.shapeTotal++;
          shapeGeometry(local as SvgShape, a, frame);
        }
      } else if (local === 'image') { if (drawn) r.images++; }
      else if (local === 'use') {
        if (drawn) { r.uses++; bounds.fail('a <use> element draws what it references, which Timmy does not resolve'); }
      } else if (local === 'svg' && parent) {
        notes.add('a nested <svg> element: its shapes are counted, and its own viewport is not followed');
        if (drawn) bounds.fail('a nested <svg> element sets a viewport of its own');
      } else if (local === 'script') notes.add('a <script> element: Timmy never runs anything in an SVG, and its text was not read');
      else if (local === 'foreignObject') notes.add('a <foreignObject> element: its content is not counted');
      else if (local === 'switch') notes.add('a <switch> element: each of its children is counted');
      else if (local === 'style') notes.add('CSS in a <style> element is not evaluated: a class that hides an element is not seen');
    }
    if (selfClosing) {
      close(frame);
      if (!parent) rootDone = true;
    } else stack.push(frame);
  };

  const close = (f: Frame): void => {
    if (f.ownsText && f.text) {
      if (f.text.drawn && texts.length < SVG_READ_LIMITS.texts) texts.push(f.text.parts.join('').replace(/\s+/g, ' ').trim());
      if (f.text.len >= SVG_READ_LIMITS.textChars) notes.add(`a text longer than ${SVG_READ_LIMITS.textChars.toLocaleString('en-US')} characters: its first ${SVG_READ_LIMITS.textChars.toLocaleString('en-US')} were read`);
    }
  };

  try {
    while (i < n) {
      const lt = s.indexOf('<', i);
      const end = lt < 0 ? n : lt;
      if (end > i) text(s.slice(i, end), false);
      if (lt < 0) break;
      i = lt;
      if (s.startsWith('<!--', i)) {
        const e = s.indexOf('-->', i + 4);
        if (e < 0) throw new NotWellFormed(`a comment left open (at ${where(s, i)})`);
        i = e + 3;
        continue;
      }
      if (s.startsWith('<![CDATA[', i)) {
        const e = s.indexOf(']]>', i + 9);
        if (e < 0) throw new NotWellFormed(`a CDATA section left open (at ${where(s, i)})`);
        if (!stack.length) throw new NotWellFormed('a CDATA section outside the root element');
        text(s.slice(i + 9, e), true);
        i = e + 3;
        continue;
      }
      if (s.startsWith('<!DOCTYPE', i)) {
        if (rootSeen) throw new NotWellFormed('a DOCTYPE after the root element');
        const d = doctypeEnd(s, i);
        notes.add(d.entities ? 'a DOCTYPE that declares entities: Timmy never expands them' : 'a DOCTYPE (not read further)');
        i = d.end;
        continue;
      }
      if (s.startsWith('<?', i)) {
        const e = s.indexOf('?>', i + 2);
        if (e < 0) throw new NotWellFormed(`a processing instruction left open (at ${where(s, i)})`);
        i = e + 2;
        continue;
      }
      if (s[i + 1] === '!') throw new NotWellFormed(`a declaration that is not a comment, CDATA or DOCTYPE (at ${where(s, i)})`);
      if (s[i + 1] === '/') {
        let j = i + 2;
        if (j >= n || !isNameStart(s.charCodeAt(j))) throw new NotWellFormed(`an end tag without a name (at ${where(s, i)})`);
        while (j < n && isNameChar(s.charCodeAt(j))) j++;
        const name = s.slice(i + 2, j);
        while (j < n && isSpace(s.charCodeAt(j))) j++;
        if (s[j] !== '>') throw new NotWellFormed(`an end tag </${name}> not closed by > (at ${where(s, i)})`);
        const top = stack.pop();
        if (!top || top.name !== name) throw new NotWellFormed(`</${name}> closes ${top ? `<${top.name}>` : 'nothing'} (at ${where(s, i)})`);
        close(top);
        if (!stack.length) rootDone = true;
        i = j + 1;
        continue;
      }
      // A start tag: its name, then attributes (name = "value" or 'value', white space before each), then > or />.
      let j = i + 1;
      if (j >= n || !isNameStart(s.charCodeAt(j))) throw new NotWellFormed(`a < that does not start a tag (at ${where(s, i)})`);
      while (j < n && isNameChar(s.charCodeAt(j))) j++;
      const name = s.slice(i + 1, j);
      if (!stack.length && rootDone) throw new NotWellFormed(`an element after the root element (at ${where(s, i)})`);
      const attrs = new Map<string, string>();
      let selfClosing = false;
      for (;;) {
        const before = j;
        while (j < n && isSpace(s.charCodeAt(j))) j++;
        if (j >= n) throw new NotWellFormed(`a tag <${name}> left open`);
        if (s[j] === '>') { j++; break; }
        if (s[j] === '/' && s[j + 1] === '>') { j += 2; selfClosing = true; break; }
        if (j === before) throw new NotWellFormed(`no white space before an attribute of <${name}> (at ${where(s, j)})`);
        const an = j;
        if (!isNameStart(s.charCodeAt(j))) throw new NotWellFormed(`an attribute of <${name}> without a name (at ${where(s, j)})`);
        while (j < n && isNameChar(s.charCodeAt(j))) j++;
        const aname = s.slice(an, j);
        while (j < n && isSpace(s.charCodeAt(j))) j++;
        if (s[j] !== '=') throw new NotWellFormed(`the attribute ${aname} of <${name}> without a value (at ${where(s, j)})`);
        j++;
        while (j < n && isSpace(s.charCodeAt(j))) j++;
        const q = s[j];
        if (q !== '"' && q !== "'") throw new NotWellFormed(`the attribute ${aname} of <${name}> without quotes (at ${where(s, j)})`);
        const qe = s.indexOf(q, j + 1);
        if (qe < 0) throw new NotWellFormed(`the attribute ${aname} of <${name}> left open`);
        const raw = s.slice(j + 1, qe);
        if (raw.includes('<')) throw new NotWellFormed(`a < in the attribute ${aname} of <${name}> (at ${where(s, j)})`);
        if (attrs.has(aname)) throw new NotWellFormed(`the attribute ${aname} given twice on <${name}> (at ${where(s, an)})`);
        attrs.set(aname, decode(raw, notes));
        j = qe + 1;
      }
      open(name, attrs, selfClosing, i);
      i = j;
    }
    if (stack.length) throw new NotWellFormed(`<${stack[stack.length - 1].name}> left open at the end of the file`);
    if (!rootSeen) throw new NotWellFormed('no <svg> element');
  } catch (e) {
    if (e instanceof NotWellFormed) return { ok: false, why: `not well-formed XML: ${e.message}` };
    throw e;
  }
  if (r.images) notes.add('images are drawn: they are counted, and not in the shapes\' bounds');
  const computed = !bounds.why;
  return {
    ok: true,
    ...(viewBox ? { viewBox } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}),
    namespace, shapes, shapeTotal: r.shapeTotal, defined: r.defined, hidden: r.hidden,
    texts, textTotal: r.textTotal, images: r.images, uses: r.uses, elements: r.elements,
    bounds: {
      box: computed && bounds.any ? [bounds.x0, bounds.y0, bounds.x1, bounds.y1] : null,
      computed,
      ...(bounds.why ? { why: bounds.why } : {}),
      tolerance: computed && eps > 0 ? (bounds.any ? bounds.err : 0) : null,
    },
    notes: notes.list,
  };
}

/** An SVG file read as readSvgText reads its text: a regular file (not a link), at most 32 MB, UTF-8. */
export function readSvgFile(file: string, o: { precision?: number } = {}): SvgRead {
  let st;
  try { st = lstatSync(file); } catch { return { ok: false, why: 'it is not there' }; }
  if (st.isSymbolicLink()) return { ok: false, why: 'it is a symbolic link (not followed)' };
  if (!st.isFile()) return { ok: false, why: 'it is not a file' };
  if (st.size > SVG_READ_LIMITS.bytes) return { ok: false, why: `it is larger than ${SVG_READ_LIMITS.bytes / 1024 / 1024} MB (not read)` };
  const bytes = readHead(file, SVG_READ_LIMITS.bytes);
  if (!bytes) return { ok: false, why: 'it could not be read' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false, why: 'it is not UTF-8 text' }; }
  return readSvgText(text, o);
}

/** The first `max` bytes of a regular file, or undefined. */
function readHead(file: string, max: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    if (!fstatSync(fd).isFile()) return undefined;
    const size = Math.min(fstatSync(fd).size, max);
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const k = readSync(fd, buf, got, size - got, got);
      if (k <= 0) break;
      got += k;
    }
    return buf.subarray(0, got);
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

/** The eight bytes every PNG file starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's size in pixels from its IHDR chunk (the first chunk every PNG has), or why it could not be read. */
export function readPngSize(file: string): { width: number; height: number } | { why: string } {
  const b = readHead(file, 33);
  if (!b) return { why: 'it could not be read' };
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return { why: 'it does not start with the PNG signature' };
  if (b.subarray(12, 16).toString('latin1') !== 'IHDR') return { why: 'its first chunk is not IHDR' };
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (!width || !height) return { why: 'its IHDR gives a size of 0' };
  return { width, height };
}

/** A file's first bytes as text, when they are printable ASCII ("%PDF-1.7"), for saying what a file starts with. */
export function fileStart(file: string, max = 8): string | undefined {
  const b = readHead(file, max);
  if (!b || !b.length) return undefined;
  let out = '';
  for (const c of b) {
    if (c < 0x20 || c > 0x7e) break;
    out += String.fromCharCode(c);
  }
  return out || undefined;
}
