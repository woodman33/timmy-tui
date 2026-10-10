/**
 * Round R4 (H60): what the live board's /file route (src/repl/board-live.ts) may hand to its page.
 *
 * The audit behind it (each route of the live board's server, and what it can serve on the board's own origin,
 * http://127.0.0.1:<port>):
 *   GET /        the page's shell (livePage): fixed text and the board's own scripts; no project data in it.
 *   GET /state   JSON (application/json, nosniff), only with the token in an Authorization header: a navigation cannot
 *                send one, so a tab opened on /state gets the 401 text, never the project's data.
 *   POST /action, POST /edit, and every refusal: text/plain with nosniff; a browser shows them as text, never as markup.
 *   GET /file    a VoxVision highlight, only with the token: the bytes of a project file (results/vox/<id>/…​.png|svg)
 *                whose sha256 a vox receipt sealed. Those bytes are a project's (any process that can write the project
 *                and its runs chain can make them), and the page turns them into a blob: URL, which has the board's own
 *                origin: an SVG opened from it (Open image in new tab) is a document on the board's origin, where a script
 *                in it would run with the board's rights unless the page's inherited policy stops it. That is the one route
 *                that could serve project-controlled content as a document there, and this module is its fix: /file
 *                answers only with a PNG that starts with the PNG signature, or an SVG made only of the drawing elements
 *                and attributes Timmy's own SVG writer uses (src/vox/svg.ts): no script, no event handler, no link, no
 *                foreignObject, no style, no url(), no DOCTYPE or entity, no processing instruction but the XML
 *                declaration, nothing prefixed. Anything else is not served (the page says the highlight is not shown).
 *                The route also sends every file as a download, under a sandboxing policy (an opaque origin, no script),
 *                so even a direct load of it runs nothing on the board's origin.
 *   anything else  404 text/plain.
 * The live board serves no other files: no fonts, no static assets, no project files besides /file's highlights.
 */

/** The eight bytes every PNG file starts with. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const SVG_NS = 'http://www.w3.org/2000/svg';
/** The largest SVG this guard reads through; a larger one is not served. */
export const SVG_CHECK_LIMIT = 4 * 1024 * 1024;

/** The SVG elements a highlight may hold: shapes and text, nothing that loads, links, animates or runs anything. */
const ELEMENTS: ReadonlySet<string> = new Set(['svg', 'g', 'title', 'desc', 'rect', 'line', 'polyline', 'polygon', 'path', 'circle', 'ellipse', 'text', 'tspan']);
/** Their attributes: geometry and presentation only. No href, no style, no on…, no id references, nothing prefixed. */
const ATTRIBUTES: ReadonlySet<string> = new Set([
  'xmlns', 'version', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'dx', 'dy',
]);

export type GuardAnswer = { ok: true; type: 'image/png' | 'image/svg+xml' } | { ok: false; why: string };

const XML_DECL = /<\?xml\s+version\s*=\s*(["'])1\.[01]\1(?:\s+encoding\s*=\s*(["'])utf-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/iy;
const END_TAG = /<\/([A-Za-z][A-Za-z0-9]*)\s*>/y;
const START_TAG = /<([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][A-Za-z0-9-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const ATTRIBUTE = /\s+([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;
/** In text: the five named entities and character references (they only ever make text). */
const TEXT_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});)/;
/** In an attribute value: the five named entities only (a character reference could hide a word from the checks below). */
const VALUE_ENTITY = /&(?!(?:amp|lt|gt|quot|apos);)/;
const VALUE_WORDS = /url\s*\(|javascript|data\s*:|expression|@import/i;

/**
 * Whether an SVG text holds only drawing: one <svg> root in the SVG namespace, the elements and attributes above, text,
 * comments and an optional UTF-8 XML declaration. Anything this cannot read as exactly that is refused, with why.
 */
export function inertSvg(src: string): { ok: true } | { ok: false; why: string } {
  const fail = (why: string): { ok: false; why: string } => ({ ok: false, why });
  const s = src.startsWith('﻿') ? src.slice(1) : src;
  let i = 0;
  XML_DECL.lastIndex = 0;
  const decl = XML_DECL.exec(s);
  if (decl) i = decl[0].length;
  else if (/^\s*<\?xml\s/i.test(s)) return fail('an XML declaration other than version 1.0 or 1.1 in UTF-8');
  const open: string[] = [];
  let root = false;
  let ended = false;
  while (i < s.length) {
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end < 0) return fail('a comment left open');
      if (s.slice(i + 4, end).includes('--')) return fail('a comment holding --');
      i = end + 3;
      continue;
    }
    if (s[i] === '<') {
      if (s[i + 1] === '!') return fail('a DOCTYPE, CDATA section or other declaration');
      if (s[i + 1] === '?') return fail('a processing instruction');
      if (s[i + 1] === '/') {
        END_TAG.lastIndex = i;
        const m = END_TAG.exec(s);
        if (!m) return fail('a malformed or prefixed end tag');
        if (open.pop() !== m[1]) return fail(`</${m[1]}> closes no open <${m[1]}>`);
        if (!open.length) ended = true;
        i = END_TAG.lastIndex;
        continue;
      }
      START_TAG.lastIndex = i;
      const m = START_TAG.exec(s);
      if (!m) return fail('a malformed or prefixed tag');
      const name = m[1];
      if (!ELEMENTS.has(name)) return fail(`the element <${name}>`);
      if (ended) return fail('an element after the root element');
      if (!open.length && name !== 'svg') return fail('a root element other than <svg>');
      const seen = new Map<string, string>();
      ATTRIBUTE.lastIndex = 0;
      for (let a = ATTRIBUTE.exec(m[2]); a; a = ATTRIBUTE.exec(m[2])) {
        const an = a[1];
        const value = a[2] ?? a[3] ?? '';
        if (!ATTRIBUTES.has(an)) return fail(`the attribute ${an} on <${name}>`);
        if (seen.has(an)) return fail(`the attribute ${an} given twice`);
        if (VALUE_ENTITY.test(value)) return fail(`a character reference in the attribute ${an}`);
        if (VALUE_WORDS.test(value)) return fail(`url(), a scheme or an expression in the attribute ${an}`);
        if (an === 'xmlns' && value !== SVG_NS) return fail('a namespace other than SVG\'s');
        seen.set(an, value);
      }
      if (!open.length) {
        if (seen.get('xmlns') !== SVG_NS) return fail('an <svg> root outside the SVG namespace');
        root = true;
      }
      if (m[3]) { if (!open.length) ended = true; } else open.push(name);
      i = START_TAG.lastIndex;
      continue;
    }
    const next = s.indexOf('<', i);
    const text = s.slice(i, next < 0 ? s.length : next);
    if (!open.length && text.trim()) return fail('text outside the root element');
    if (TEXT_ENTITY.test(text)) return fail('an entity reference');
    if (text.includes(']]>')) return fail(']]> in text');
    i = next < 0 ? s.length : next;
  }
  if (open.length) return fail(`<${open[open.length - 1]}> left open`);
  if (!root) return fail('no <svg> element');
  return { ok: true };
}

/**
 * Whether a highlight's bytes may be served as the type it was given: a PNG must start with the PNG signature; an SVG
 * must be UTF-8 text that inertSvg passes. Every other type is refused. The answer is the type to serve, or why not.
 */
export function imageOnly(type: string, body: Buffer): GuardAnswer {
  const t = type.split(';')[0].trim().toLowerCase();
  if (t === 'image/png') {
    return body.length >= PNG_SIGNATURE.length && body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      ? { ok: true, type: 'image/png' } : { ok: false, why: 'it does not start with the PNG signature' };
  }
  if (t === 'image/svg+xml') {
    if (body.length > SVG_CHECK_LIMIT) return { ok: false, why: `it is larger than ${SVG_CHECK_LIMIT / 1024 / 1024} MB` };
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return { ok: false, why: 'it is not UTF-8 text' }; }
    const inert = inertSvg(text);
    return inert.ok ? { ok: true, type: 'image/svg+xml' } : { ok: false, why: `it holds ${inert.why}` };
  }
  return { ok: false, why: `${t || 'no type'} is not an image type the board shows` };
}

/** The headers /file adds: a download, and a policy under which the file, opened by itself, runs nothing and has no origin. */
export const FILE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Disposition': 'attachment',
  'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
