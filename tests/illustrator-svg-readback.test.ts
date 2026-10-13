/**
 * Round R4 (helper H64): Timmy's own reading of an SVG (src/native/svg-readback.ts) and its comparison with Illustrator's
 * report (compareIllustratorReadback in src/native/illustrator.ts). Everything here is real SVG text written in this file:
 * an SVG in the form Illustrator's SVG 1.1 export writes (a hand-written sample, not Illustrator's output), shapes whose
 * bounds are worked out by hand, and hostile text (entities, an entity bomb, an external entity, scripts, CDATA, huge
 * numbers, deep nesting, long runs, malformed XML). Nothing here runs Illustrator.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { compareIllustratorReadback, illustratorCheckLine, type IllustratorReport } from '../src/native/illustrator.js';
import { fileStart, readPngSize, readSvgFile, readSvgText, SVG_READ_LIMITS, type SvgReading } from '../src/native/svg-readback.js';

const dirs: string[] = [];
const temp = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'timmy-svg-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ok = (svg: string, precision?: number): SvgReading => {
  const r = readSvgText(svg, precision === undefined ? {} : { precision });
  if (!r.ok) throw new Error(`not read: ${r.why}`);
  return r;
};
const wrap = (body: string, head = ''): string => `<?xml version="1.0" encoding="utf-8"?>\n${head}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const close = (a: number[] | null, b: number[]): void => { expect(a).not.toBeNull(); a!.forEach((x, k) => expect(x, `side ${k}`).toBeCloseTo(b[k], 9)); };

/** An SVG in the form Illustrator's SVG 1.1 export writes (hand-written here: not Illustrator's own output). */
const ILLUSTRATOR_STYLE = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 30.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
\t width="595.3px" height="841.9px" viewBox="0 0 595.3 841.9" style="enable-background:new 0 0 595.3 841.9;" xml:space="preserve">
<style type="text/css">
\t.st0{fill:#121212;stroke:#28FE14;stroke-width:4;}
\t.st1{display:none;}
</style>
<g id="Badge">
\t<rect x="20" y="20" class="st0" width="555.3" height="801.9"/>
\t<circle class="st0" cx="297.65" cy="200" r="90"/>
\t<ellipse class="st0" cx="100" cy="600" rx="40" ry="10"/>
\t<polygon class="st0" points="297.65,140 310,180 285.3,180 "/>
\t<polyline class="st0" points="50,700 60,710 70,700 "/>
\t<line class="st0" x1="140" y1="270" x2="455.3" y2="270"/>
\t<path class="st0" d="M100,300c0-11,9-20,20-20s20,9,20,20s-9,20-20,20S100,311,100,300z"/>
\t<text transform="matrix(1 0 0 1 233.5 330)"><tspan x="0" y="0" class="st0">TIM</tspan><tspan x="40" y="0">MY &amp; co</tspan></text>
</g>
<g id="Hidden" style="display:none;">
\t<rect x="0" y="0" width="5" height="5"/>
\t<text transform="matrix(1 0 0 1 0 0)">secret</text>
</g>
<defs><clipPath id="c"><rect width="10" height="10"/></clipPath></defs>
</svg>
`;

describe('reading an SVG in the form Illustrator exports', () => {
  it('the root\'s size with its digits, shapes by element, texts with their tspans joined, definitions and hidden ones apart', () => {
    const r = ok(ILLUSTRATOR_STYLE, 3);
    expect(r.viewBox).toEqual({ box: [0, 0, 595.3, 841.9], decimals: [0, 0, 1, 1] });
    expect([r.width, r.height]).toEqual([{ value: 595.3, unit: 'px', raw: '595.3px', decimals: 1 }, { value: 841.9, unit: 'px', raw: '841.9px', decimals: 1 }]);
    expect(r.namespace).toBe(true);
    expect(r.shapes).toEqual({ path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1 });
    expect(r.shapeTotal).toBe(7);
    expect(r.texts).toEqual(['TIMMY & co']);
    expect(r.textTotal).toBe(1);
    // the clip path's rect is a definition; the hidden group's rect and text are hidden
    expect([r.defined, r.hidden]).toEqual([1, 2]);
    expect(r.notes).toEqual(['a DOCTYPE (not read further)', 'CSS in a <style> element is not evaluated: a class that hides an element is not seen']);
    // The bounds, worked out by hand: the rect spans 20..575.3 and 20..821.9; every other shape lies inside it.
    close(r.bounds.box, [20, 20, 575.3, 821.9]);
    expect(r.bounds).toMatchObject({ computed: true });
    // precision 3: an absolute coordinate is off by at most 0.0005; a rect's far corner by two such roundings
    expect(r.bounds.tolerance).toBeCloseTo(0.001, 12);
  });

  it('curves: a cubic\'s and a quadratic\'s turning points, smooth curves, an arc\'s extreme, relative chains in the tolerance', () => {
    // a cubic bulging up to y = -7.5 (0.75 of its control points' -10), within x 0..10
    close(ok(wrap('<path d="M0,0 C0,-10 10,-10 10,0"/>')).bounds.box, [0, -7.5, 10, 0]);
    // a quadratic reaching y = -5 at t = 0.5
    close(ok(wrap('<path d="M0,0 Q5,-10 10,0"/>')).bounds.box, [0, -5, 10, 0]);
    // the circle drawn as four smooth relative curves (the sample's path): radius 20 about (120, 300)
    const circle = ok(wrap('<path d="M100,300c0-11,9-20,20-20s20,9,20,20s-9,20-20,20S100,311,100,300z"/>'), 3);
    close(circle.bounds.box, [100, 280, 140, 320]);
    // a half circle swept through the top: (0,0) to (20,0), radius 10, sweep 1 (y grows downward), so it reaches y = -10
    close(ok(wrap('<path d="M0,0 A10,10 0 0 1 20,0"/>')).bounds.box, [0, -10, 20, 0]);
    close(ok(wrap('<path d="M0,0 A10,10 0 0 0 20,0"/>')).bounds.box, [0, 0, 20, 10]);
    // flags written without separators (a25 25 0 1150 -25: large 1, sweep 1, then 50)
    expect(ok(wrap('<path d="M10,10 a25 25 0 1150 -25"/>')).bounds.computed).toBe(true);
    // relative commands chain their rounding: three relative steps after an absolute point
    const chain = ok(wrap('<path d="M0,0 l10,0 l0,10 l-10,0 z"/>'), 3);
    close(chain.bounds.box, [0, 0, 10, 10]);
    expect(chain.bounds.tolerance).toBeCloseTo(4 * 0.0005, 12);
    // no precision given: the bounds carry no tolerance
    expect(ok(wrap('<rect width="5" height="5"/>')).bounds.tolerance).toBeNull();
  });

  it('transforms: rotate, matrix and nested groups, each shape through its own; an ellipse rotated keeps its exact extent', () => {
    // rotate(90): (x, y) -> (-y, x); the rect 10 wide and 20 tall lies at x -20..0, y 0..10
    close(ok(wrap('<rect width="10" height="20" transform="rotate(90)"/>')).bounds.box, [-20, 0, 0, 10]);
    close(ok(wrap('<g transform="translate(5 5)"><g transform="scale(2)"><rect width="10" height="10"/></g></g>')).bounds.box, [5, 5, 25, 25]);
    // an ellipse of radii 30 and 10 turned 90° about its centre (50, 50): 10 wide either side, 30 tall
    close(ok(wrap('<ellipse cx="50" cy="50" rx="30" ry="10" transform="rotate(90 50 50)"/>')).bounds.box, [40, 20, 60, 80]);
    // turned 45°: each half-extent is sqrt((30 cos 45)^2 + (10 sin 45)^2)
    const h = Math.sqrt(450 + 50);
    close(ok(wrap('<ellipse cx="0" cy="0" rx="30" ry="10" transform="rotate(45)"/>')).bounds.box, [-h, -h, h, h]);
    close(ok(wrap('<text transform="matrix(1 0 0 1 233.5 330)">t</text><line x1="1" y1="2" x2="3" y2="4" transform="matrix(1 0 0 1 10 20)"/>')).bounds.box, [11, 22, 13, 24]);
    const bad = ok(wrap('<rect width="1" height="1" transform="spin(9)"/>'));
    expect(bad.bounds).toMatchObject({ computed: false, box: null, why: 'a transform that could not be read (spin with 1 number)' });
  });

  it('what it cannot compute without a renderer it says, and still counts: a <use>, a length in mm, a nested <svg>; nothing drawn is no box', () => {
    expect(ok(wrap('<rect width="1" height="1"/><use href="#c"/>'))).toMatchObject({ uses: 1, bounds: { computed: false, why: 'a <use> element draws what it references, which Timmy does not resolve' } });
    expect(ok(wrap('<rect width="1mm" height="1"/>')).bounds).toMatchObject({ computed: false, why: 'a width in mm (lengths in units other than px are not converted)' });
    const nested = ok(wrap('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'));
    expect(nested.shapeTotal).toBe(1);
    expect(nested.bounds.computed).toBe(false);
    expect(ok(wrap('<text>only words</text>'), 3).bounds).toEqual({ box: null, computed: true, tolerance: 0 });
    // SVG draws nothing for a rect of no width, or a circle of no radius: counted, adding nothing to the box
    expect(ok(wrap('<rect width="0" height="5"/><circle r="0"/><rect x="1" y="2" width="3" height="4"/>')).bounds.box).toEqual([1, 2, 4, 6]);
  });
});

describe('hostile SVG text: read, never run or expanded', () => {
  it('entities: the five named ones and character references are decoded into characters, never into elements', () => {
    const r = ok(wrap('<text>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#60;rect/&#62; &#x263A; &#128512;</text>'));
    expect(r.texts).toEqual(['<script>alert(1)</script> & <rect/> ☺ 😀']);
    expect(r.shapeTotal).toBe(0);
    expect(r.notes).toEqual([]);
    // a reference to a character XML does not allow is read as U+FFFD and noted
    const bad = ok(wrap('<text>a&#0;b&#xD800;c&#x110000;</text>'));
    expect(bad.texts).toEqual(['a�b�c�']);
    expect(bad.notes[0]).toMatch(/^a character reference to a character XML does not allow \(&#0;\): read as U\+FFFD$/);
  });

  it('an entity bomb and an external entity declared in a DOCTYPE are never expanded: kept as written, at once', () => {
    const lol = ['<!ENTITY lol "lol">', ...Array.from({ length: 9 }, (_, k) => `<!ENTITY lol${k + 1} "${`&lol${k === 0 ? '' : k};`.repeat(10)}">`)].join('\n');
    const started = Date.now();
    const r = ok(wrap('<text>&lol9;</text>', `<!DOCTYPE svg [\n${lol}\n]>\n`));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.texts).toEqual(['&lol9;']);
    expect(r.notes).toEqual(['a DOCTYPE that declares entities: Timmy never expands them', 'an entity Timmy does not expand (&lol9;): kept as written']);
    const xxe = ok(wrap('<text>&xxe;</text>', '<!DOCTYPE svg [ <!ENTITY xxe SYSTEM "file:///etc/hostname"> ]>\n'));
    expect(xxe.texts).toEqual(['&xxe;']);
    // an entity in an attribute (as Illustrator writes xmlns:x="&ns_extend;" with editing kept) is kept as written too
    expect(ok('<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="&ns_extend;" viewBox="0 0 1 1"/>').notes).toEqual(['an entity Timmy does not expand (&ns_extend;): kept as written']);
  });

  it('a <script> is named and never run; its text, CDATA or not, is not read, and an element inside it is not drawn', () => {
    const r = ok(wrap('<script type="text/ecmascript"><![CDATA[ document.write("<rect/>"); ]]></script><script>if (a &lt; b) {}</script><script><rect width="9" height="9"/></script><rect width="1" height="1"/>'));
    expect(r.shapeTotal).toBe(1);
    expect(r.defined).toBe(1);
    expect(r.texts).toEqual([]);
    expect(r.notes).toEqual(['a <script> element: Timmy never runs anything in an SVG, and its text was not read']);
    // a CDATA section inside a text is the text's own characters
    expect(ok(wrap('<text><![CDATA[a < b & c]]></text>')).texts).toEqual(['a < b & c']);
    // a foreignObject's content and an element in another namespace are not counted
    expect(ok(wrap('<foreignObject><rect width="1" height="1"/></foreignObject><i:pgf xmlns:i="x">AAAA</i:pgf>')).shapeTotal).toBe(0);
  });

  it('huge numbers: a coordinate past what a double holds leaves the bounds not computed; a long number is read in one pass', () => {
    expect(ok(wrap('<rect x="1e309" width="5" height="5"/>')).bounds).toMatchObject({ computed: false, why: 'a coordinate that is not a finite number' });
    expect(ok(wrap('<circle r="1e400"/>')).bounds.computed).toBe(false);
    expect(ok(wrap('<path d="M0,0 L1e308,1e308"/>')).bounds.box).toEqual([0, 0, 1e308, 1e308]);
    const long = `1${'0'.repeat(500_000)}`;
    const started = Date.now();
    expect(ok(wrap(`<rect width="${long}" height="1"/>`)).bounds.computed).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('long runs and deep nesting: a megabyte of spaces in a tag is read in one pass; past the limits it refuses, saying which', () => {
    let started = Date.now();
    expect(ok(wrap(`<rect${' '.repeat(1_000_000)}width="2" height="3"/>`)).bounds.box).toEqual([0, 0, 2, 3]);
    expect(Date.now() - started).toBeLessThan(2000);
    const deep = `${'<g>'.repeat(SVG_READ_LIMITS.depth)}${'</g>'.repeat(SVG_READ_LIMITS.depth)}`;
    expect(readSvgText(wrap(deep))).toEqual({ ok: false, why: `not well-formed XML: elements nested deeper than ${SVG_READ_LIMITS.depth}` });
    started = Date.now();
    expect(readSvgText(wrap('<g/>'.repeat(SVG_READ_LIMITS.elements)))).toEqual({ ok: false, why: 'not well-formed XML: more than 200,000 elements' });
    expect(Date.now() - started).toBeLessThan(5000);
    // path data past its numbers' budget: the shape is counted and the bounds say why they were not computed
    const many = ok(wrap(`<path d="M0,0${' l1,1'.repeat(SVG_READ_LIMITS.numbers / 2 + 1)}"/>`));
    expect(many.bounds).toMatchObject({ computed: false, why: 'more than 4,000,000 numbers in path data' });
  });

  it('malformed XML is refused with where and why, never guessed at', () => {
    const why = (svg: string): string => { const r = readSvgText(svg); return r.ok ? 'read' : r.why; };
    expect(why(wrap('<rect width="1"'))).toMatch(/^not well-formed XML: /);
    expect(why(wrap('<g><rect/></svg>'))).toMatch(/^not well-formed XML: <\/svg> closes <g>/);
    expect(why(wrap('<text>fish & chips</text>'))).toBe('not well-formed XML: an & that does not start a reference');
    expect(why(wrap('<rect width=1 height="2"/>'))).toMatch(/^not well-formed XML: the attribute width of <rect> without quotes \(at line 2, column \d+\)$/);
    expect(why(wrap('<rect width="1" width="2"/>'))).toMatch(/^not well-formed XML: the attribute width given twice on <rect>/);
    expect(why(wrap('<rect title="a<b"/>'))).toMatch(/^not well-formed XML: a < in the attribute title of <rect>/);
    expect(why(`${wrap('')}<svg xmlns="http://www.w3.org/2000/svg"/>`)).toMatch(/^not well-formed XML: an element after the root element|a second root element/);
    expect(why(`${wrap('')} trailing words`)).toMatch(/^not well-formed XML: text outside the root element/);
    expect(why('<html><body/></html>')).toBe('not well-formed XML: the root element is <html>, not <svg>');
    expect(why('')).toBe('not well-formed XML: no <svg> element');
    // an attribute value holding > inside its quotes is read as written
    expect(ok(wrap('<rect data-x="a>b" width="1" height="1"/>')).shapeTotal).toBe(1);
  });

  it('a file: a regular UTF-8 file at most 32 MB, never through a link', () => {
    const d = temp();
    const good = path.join(d, 'a.svg');
    writeFileSync(good, wrap('<rect width="1" height="1"/>'));
    expect(readSvgFile(good)).toMatchObject({ ok: true, shapeTotal: 1 });
    symlinkSync(good, path.join(d, 'link.svg'));
    expect(readSvgFile(path.join(d, 'link.svg'))).toEqual({ ok: false, why: 'it is a symbolic link (not followed)' });
    writeFileSync(path.join(d, 'latin1.svg'), Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xe9, 0x2f, 0x3e]));
    expect(readSvgFile(path.join(d, 'latin1.svg'))).toEqual({ ok: false, why: 'it is not UTF-8 text' });
    const big = path.join(d, 'big.svg');
    writeFileSync(big, '');
    truncateSync(big, SVG_READ_LIMITS.bytes + 1); // sparse: no disk is used
    expect(readSvgFile(big)).toEqual({ ok: false, why: 'it is larger than 32 MB (not read)' });
    expect(readSvgFile(path.join(d, 'none.svg'))).toEqual({ ok: false, why: 'it is not there' });
    mkdirSync(path.join(d, 'dir.svg'));
    expect(readSvgFile(path.join(d, 'dir.svg'))).toEqual({ ok: false, why: 'it is not a file' });
  });
});

describe('a PNG\'s size and a file\'s first bytes', () => {
  it('reads a real PNG\'s IHDR; anything else is said for what it is', () => {
    const d = temp();
    const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, data: Buffer): Buffer => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(600, 0); ihdr.writeUInt32BE(400, 4); ihdr[8] = 8; ihdr[9] = 2;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(400 * 1801))), chunk('IEND', Buffer.alloc(0))]);
    writeFileSync(path.join(d, 'a.png'), png);
    expect(readPngSize(path.join(d, 'a.png'))).toEqual({ width: 600, height: 400 });
    writeFileSync(path.join(d, 'b.png'), '%PDF-1.7\nnot a png');
    expect(readPngSize(path.join(d, 'b.png'))).toEqual({ why: 'it does not start with the PNG signature' });
    expect(fileStart(path.join(d, 'b.png'))).toBe('%PDF-1.7');
    expect(fileStart(path.join(d, 'a.png'))).toBeUndefined();
  });
});

describe('Timmy\'s reading against Illustrator\'s report', () => {
  const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="600px" height="400px" viewBox="0 0 600 400"><rect x="20" y="20" width="560" height="360"/><circle cx="300" cy="150" r="90"/><line x1="140" y1="270" x2="460" y2="270"/><text transform="matrix(1 0 0 1 300 330)">TIMMY</text></svg>`;
  /** Illustrator's report of that badge: artboard [0, 0, 600, -400] (y grows upward), the rect's bounds [20, -20, 580, -380]. */
  const report = (over: Partial<NonNullable<IllustratorReport['drawn']>> = {}, rect: [number, number, number, number] = [0, 0, 600, -400]): IllustratorReport => ({
    artboards: [{ index: 1, name: 'Badge', rect, width: rect[2] - rect[0], height: rect[1] - rect[3] }], active_artboard: 1, layers: [{ name: 'Badge', depth: 0, visible: true, locked: false, items: 4 }],
    path_items: [], text_frames: [],
    drawn: { shapes: 3, bounds: [rect[0] + 20, rect[1] - 20, rect[0] + 580, rect[1] - 380], texts: ['TIMMY'], hidden: 0, guides: 0, clipping: 0, in_compound: 0, ...over },
  });

  it('agrees on the artboard, the shapes, the texts and the bounds, wherever the artboard sits in Illustrator\'s coordinates', () => {
    for (const rect of [[0, 0, 600, -400], [100, 900, 700, 500]] as Array<[number, number, number, number]>) {
      const c = compareIllustratorReadback('out/b.svg', readSvgText(badge, { precision: 3 }), report({}, rect), { precision: 3 });
      expect(c).toMatchObject({
        verdict: 'agrees', svg: 'out/b.svg',
        artboard: { illustrator: [600, 400], svg: [600, 400], from: 'viewBox', agrees: true },
        shapes: { illustrator: 3, svg: 3, by_element: { rect: 1, circle: 1, line: 1 }, agrees: true },
        texts: { illustrator: ['TIMMY'], svg: ['TIMMY'], agrees: true },
        bounds: { illustrator: [20, 20, 580, 380], svg: [20, 20, 580, 380], agrees: true, tolerance: 0.001 },
      });
    }
    // texts are compared without their spaces and line breaks, in any order
    const two = compareIllustratorReadback('b.svg', readSvgText(badge.replace('TIMMY', 'TIM MY'), { precision: 3 }), report({ texts: ['TIM\rMY'] }), { precision: 3 });
    expect(two.texts?.agrees).toBe(true);
  });

  it('differs with both numbers, part by part, and says so in one line', () => {
    const c = compareIllustratorReadback('b.svg', readSvgText(badge, { precision: 3 }), report({ shapes: 4, texts: ['TIMMY 2'], bounds: [20, -20, 580, -390] }), { precision: 3 });
    expect(c.verdict).toBe('differs');
    expect(c.shapes).toMatchObject({ illustrator: 4, svg: 3, agrees: false });
    expect(c.texts).toMatchObject({ illustrator: ['TIMMY 2'], svg: ['TIMMY'], agrees: false });
    expect(c.bounds).toMatchObject({ illustrator: [20, 20, 580, 390], svg: [20, 20, 580, 380], agrees: false });
    expect(illustratorCheckLine(c)).toBe('differs: artboard 600 × 400 (viewBox); shapes differ: Illustrator 4, the SVG 3 (rect 1, circle 1, line 1); texts differ: Illustrator "TIMMY 2", the SVG "TIMMY"; bounds differ: Illustrator (20, 20)–(580, 390), the SVG (20, 20)–(580, 380) (±0.001)');
  });

  it('the artboard is compared to the digits the SVG wrote: 595.3 for A4\'s 595.276 agrees; 596 does not', () => {
    const a4 = [0, 0, 595.276, -841.89] as [number, number, number, number];
    const svg = (w: string, h: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"/>`;
    const rep = report({ shapes: 0, bounds: null, texts: [] }, a4);
    expect(compareIllustratorReadback('a.svg', readSvgText(svg('595.3', '841.9')), rep, { precision: 3 }).artboard).toMatchObject({ agrees: true, tolerance: [0.05, 0.05] });
    const off = compareIllustratorReadback('a.svg', readSvgText(svg('596', '841.9')), rep, { precision: 3 });
    expect(off.artboard).toMatchObject({ illustrator: [595.276, 841.89], svg: [596, 841.9], agrees: false });
    expect(off.verdict).toBe('differs');
  });

  it('not compared when the SVG cannot be read or Illustrator reported nothing; bounds not compared without a precision', () => {
    expect(compareIllustratorReadback('x.svg', readSvgText('<svg'), report(), { precision: 3 })).toMatchObject({ verdict: 'not compared', why: expect.stringMatching(/^Timmy could not read x\.svg: not well-formed XML/) });
    expect(compareIllustratorReadback('x.svg', readSvgText(badge), undefined, { precision: 3 })).toMatchObject({ verdict: 'not compared', why: 'Illustrator reported nothing of the document to compare with' });
    const noPrecision = compareIllustratorReadback('x.svg', readSvgText(badge), report(), { precision: 3 });
    expect(noPrecision.bounds).toMatchObject({ agrees: null, why: 'the precision the SVG was written at is not known' });
    expect(noPrecision.verdict).toBe('agrees');
    const truncated = compareIllustratorReadback('x.svg', readSvgText('<svg xmlns="http://www.w3.org/2000/svg"/>'), { ...report({ truncated: true }), artboards: [] }, { precision: 3 });
    expect(truncated).toMatchObject({ verdict: 'not compared', why: 'the document has more than 5,000 items of a kind, past what the harness reads' });
  });
});
