/**
 * Round R4 (H60): the audit of the live board's routes, as tests. A temporary project holds hostile files: an .html page,
 * an .svg with a script, and a file named like a PNG that holds HTML, each named as a highlight of a VoxVision record that
 * a vox receipt on the project's REAL receipts chain sealed (tests/helpers/memory-kit.ts: appendReceipt, hash-chained and
 * signed), so the record check passes and only the route's own guard stands between them and the page. Every request is
 * real HTTP to the Workspace's live board on 127.0.0.1. No model, agent or tool runs here.
 */
import { readFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { imageOnly, inertSvg, PNG_SIGNATURE } from '../src/repl/board-file-guard.js';
import { voxFileFor } from '../src/repl/board-vox.js';
import { bboxSvg } from '../src/vox/svg.js';
import { chainOf, memoryKit, put, sealIn, sha, workspace } from './helpers/memory-kit.js';

const kit = memoryKit();
afterEach(async () => { await kit.cleanup(); });

const ID = 'v0000aaaa';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MARK = 'HOSTILE-MARK-7f3e';
const svgWith = (inner: string, attrs = ''): string => `<svg xmlns="${SVG_NS}" width="10" height="10"${attrs}>${inner}</svg>`;

/** The hostile highlights, and two honest ones (Timmy's own bounding-box SVG, and a real PNG header). */
function files(): Record<string, Buffer> {
  return {
    'page.html': Buffer.from(`<!doctype html><title>${MARK}</title><script>parent.postMessage("${MARK}","*")</script>`),
    'evil.svg': Buffer.from(svgWith(`<script>/* ${MARK} */ new BroadcastChannel("x").postMessage(1)</script><rect width="5" height="5"/>`)),
    'onload.svg': Buffer.from(svgWith('<rect width="5" height="5"/>', ` onload="alert('${MARK}')"`)),
    'fake.png': Buffer.from(`<html><body><script>alert("${MARK}")</script></body></html>`),
    'clean.svg': Buffer.from(bboxSvg({ title: 'models/cube.stl', boxes: [{ label: "a: models/<cube>'s.stl", size: [10, 20, 30] }], unit: 'mm', measuredBy: "Timmy's STL reader" })),
    'real.png': Buffer.concat([PNG_SIGNATURE, Buffer.alloc(32, 1)]),
  };
}

/** A project whose VoxVision record names every file above as a highlight, sealed by a vox receipt on the real chain. */
function project() {
  const root = kit.temp('board-guard-');
  const f = files();
  for (const [name, body] of Object.entries(f)) put(root, `results/vox/${ID}/${name}`, body);
  const highlights = Object.entries(f).map(([name, body]) => ({ path: `results/vox/${ID}/${name}`, sha256: sha(body), type: name.endsWith('.svg') ? 'bbox-svg' : 'annotated', drawn_from: [] }));
  const record = JSON.stringify({ schema: 'timmy.vox/1', id: ID, action: 'inspect', status: 'ok', made_at: new Date().toISOString(), inputs: [], tools: [], metrics: [], claims: [], highlights, failures: [], notes: [] }, null, 2);
  put(root, `results/vox/${ID}.json`, record);
  sealIn(root, { kind: 'vox', outputs: [{ path: `results/vox/${ID}.json`, sha256: sha(record), bytes: Buffer.byteLength(record) }, ...highlights.map((h) => ({ path: h.path, sha256: h.sha256, bytes: f[h.path.split('/').pop()!].length }))] });
  const { ws } = workspace(root, kit);
  return { root, ws };
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: Buffer }
function raw(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers: { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) }, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

describe('the live board\'s routes with hostile project files (real HTTP, a real receipts chain)', () => {
  it('/file serves only an inert SVG and a real PNG, each as a sandboxed download; the .html, the scripted SVGs and the HTML named .png are not served', async () => {
    const { root, ws } = project();
    // The record check alone lets the scripted SVG and the HTML named .png through: what refuses them is the route's guard.
    const chain = chainOf(root);
    expect(voxFileFor({ root, path: `results/vox/${ID}/evil.svg`, chain })?.type).toBe('image/svg+xml');
    expect(voxFileFor({ root, path: `results/vox/${ID}/fake.png`, chain })?.type).toBe('image/png');
    expect(voxFileFor({ root, path: `results/vox/${ID}/page.html`, chain })).toBeNull();
    await ws.boardLive('live');
    const { port, url } = ws.liveBoard!;
    const token = url.split('#t=')[1];
    const auth = { Authorization: `Bearer ${token}` };
    const file = (name: string, headers: Record<string, string> = auth): Promise<Reply> => raw(port, { path: `/file?p=${encodeURIComponent(`results/vox/${ID}/${name}`)}`, headers });

    const served: Record<string, string> = {};
    for (const name of Object.keys(files())) {
      const r = await file(name);
      served[name] = `${r.status} ${r.headers['content-type']}`;
      // Every answer: nosniff, no store, no CORS; nothing hostile ever comes back as markup.
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      if (r.status === 200) {
        expect(r.headers['content-disposition']).toBe('attachment');
        expect(r.headers['content-security-policy']).toContain('sandbox');
        expect(r.headers['content-security-policy']).toContain("default-src 'none'");
        expect(sha(r.body)).toBe(sha(readFileSync(join(root, `results/vox/${ID}/${name}`))));
      } else {
        expect(r.body.toString()).not.toContain(MARK);
      }
    }
    expect(served).toEqual({
      'page.html': '404 text/plain; charset=utf-8',
      'evil.svg': '404 text/plain; charset=utf-8',
      'onload.svg': '404 text/plain; charset=utf-8',
      'fake.png': '404 text/plain; charset=utf-8',
      'clean.svg': '200 image/svg+xml',
      'real.png': '200 image/png',
    });
    expect((await file('evil.svg')).body.toString()).toBe('Not shown: this highlight is not an image the board shows (it holds the element <script>).');
    expect((await file('fake.png')).body.toString()).toBe('Not shown: this highlight is not an image the board shows (it does not start with the PNG signature).');
    // Without the token nothing is served, hostile or not.
    expect((await file('clean.svg', {})).status).toBe(401);
  });

  it('every other route: the page shell is the only HTML, it holds no project data; state is token-only JSON; the rest is text', async () => {
    const { ws } = project();
    await ws.boardLive('live');
    const { port, url } = ws.liveBoard!;
    const token = url.split('#t=')[1];
    const auth = { Authorization: `Bearer ${token}` };
    const asks: Array<[string, { method?: string; path?: string; headers?: Record<string, string>; body?: string }]> = [
      ['GET /', { path: '/' }],
      ['GET /?p=results/vox/x/page.html', { path: `/?p=results/vox/${ID}/page.html` }],
      ['GET /state (no token)', { path: '/state' }],
      ['GET /state', { path: '/state', headers: auth }],
      ['POST /action', { method: 'POST', path: '/action', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'observe', file: `results/vox/${ID}/page.html` }) }],
      ['POST /edit', { method: 'POST', path: '/edit', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"action":"nothing"}' }],
      ['GET /results/vox/x/page.html', { path: `/results/vox/${ID}/page.html`, headers: auth }],
      ['GET /favicon.ico', { path: '/favicon.ico' }],
    ];
    const types: Record<string, string> = {};
    for (const [name, o] of asks) {
      const r = await raw(port, o);
      types[name] = `${r.status} ${r.headers['content-type']}`;
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.body.toString()).not.toContain(MARK);
    }
    expect(types).toEqual({
      'GET /': '200 text/html; charset=utf-8',
      'GET /?p=results/vox/x/page.html': '200 text/html; charset=utf-8',
      'GET /state (no token)': '401 text/plain; charset=utf-8',
      'GET /state': '200 application/json; charset=utf-8',
      'POST /action': '404 text/plain; charset=utf-8',
      'POST /edit': '400 text/plain; charset=utf-8',
      'GET /results/vox/x/page.html': '404 text/plain; charset=utf-8',
      'GET /favicon.ico': '404 text/plain; charset=utf-8',
    });
    // The page shell is the same whatever the query, and names no project file.
    const a = await raw(port, { path: '/' });
    const b = await raw(port, { path: `/?p=results/vox/${ID}/page.html` });
    const shell = (r: Reply): string => r.body.toString().replace(/nonce="[^"]+"/g, 'nonce=""');
    expect(shell(a)).toBe(shell(b));
    expect(shell(a)).not.toContain('results/vox');
  });
});

describe('the guard itself', () => {
  it('passes the SVG Timmy draws (its own bounding boxes, every label escaped) and a PNG', () => {
    const svg = bboxSvg({ title: 'a & b <c>', boxes: [{ label: "a: m/'x'.stl", size: [1, 2, 3] }, { label: 'b: n.stl', size: [3, 2, 1] }], unit: 'mm', measuredBy: "Timmy's STL reader" });
    expect(inertSvg(svg)).toEqual({ ok: true });
    expect(imageOnly('image/svg+xml', Buffer.from(svg))).toEqual({ ok: true, type: 'image/svg+xml' });
    expect(imageOnly('image/svg+xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- a comment -->\n${svg}`))).toEqual({ ok: true, type: 'image/svg+xml' });
    expect(imageOnly('image/png', Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8)]))).toEqual({ ok: true, type: 'image/png' });
  });

  it('refuses every way an SVG could run, load or link something, and anything it cannot read as plain drawing', () => {
    const refused: Array<[string, string]> = [
      [svgWith('<script>alert(1)</script>'), 'the element <script>'],
      [svgWith('<rect width="1" height="1"/>', ' onload="alert(1)"'), 'the attribute onload on <svg>'],
      [svgWith('<rect width="1" height="1" onclick="alert(1)"/>'), 'the attribute onclick on <rect>'],
      [svgWith('<foreignObject><iframe src="x"></iframe></foreignObject>'), 'the element <foreignObject>'],
      [svgWith('<a href="javascript:alert(1)"><text>x</text></a>'), 'the element <a>'],
      [svgWith('<use href="#a"/>'), 'the element <use>'],
      [svgWith('<image href="https://example.invalid/x.png"/>'), 'the element <image>'],
      [svgWith('<style>@import url(x)</style>'), 'the element <style>'],
      [svgWith('<animate attributeName="href" to="javascript:alert(1)"/>'), 'the element <animate>'],
      [svgWith('<set attributeName="onload" to="alert(1)"/>'), 'the element <set>'],
      [svgWith('<rect style="fill:red" width="1" height="1"/>'), 'the attribute style on <rect>'],
      [svgWith('<rect fill="url(#g)" width="1" height="1"/>'), 'url(), a scheme or an expression in the attribute fill'],
      [svgWith('<rect fill="&#117;rl(x)" width="1" height="1"/>'), 'a character reference in the attribute fill'],
      [svgWith('<html:script xmlns:html="http://www.w3.org/1999/xhtml">alert(1)</html:script>'), 'a malformed or prefixed tag'],
      [svgWith('<rect xlink:href="x" width="1" height="1"/>'), 'a malformed or prefixed tag'],
      [svgWith('<g xmlns="http://www.w3.org/1999/xhtml"><text>x</text></g>'), 'a namespace other than SVG\'s'],
      [`<!DOCTYPE svg [<!ENTITY s "<script>alert(1)</script>">]>${svgWith('<text>&s;</text>')}`, 'a DOCTYPE, CDATA section or other declaration'],
      [svgWith('<text>&s;</text>'), 'an entity reference'],
      [`<?xml-stylesheet type="text/xsl" href="x.xsl"?>${svgWith('<text>x</text>')}`, 'a processing instruction'],
      [svgWith('<text><![CDATA[<script>alert(1)</script>]]></text>'), 'a DOCTYPE, CDATA section or other declaration'],
      [`<?xml version="1.0" encoding="UTF-16"?>${svgWith('<text>x</text>')}`, 'an XML declaration other than version 1.0 or 1.1 in UTF-8'],
      ['<svg width="1" height="1"><text>x</text></svg>', 'an <svg> root outside the SVG namespace'],
      [`<SVG xmlns="${SVG_NS}"></SVG>`, 'the element <SVG>'],
      [`<html xmlns="${SVG_NS}"><script>alert(1)</script></html>`, 'the element <html>'],
      [`<g xmlns="${SVG_NS}"></g>`, 'a root element other than <svg>'],
      [`${svgWith('<text>x</text>')}<script>alert(1)</script>`, 'the element <script>'],
      [`${svgWith('<text>x</text>')}${svgWith('')}`, 'an element after the root element'],
      [`${svgWith('<text>x</text>')}trailing text`, 'text outside the root element'],
      [`<svg xmlns="${SVG_NS}"><g><text>x</text></svg>`, '</svg> closes no open <svg>'],
      [`<svg xmlns="${SVG_NS}"><g>`, '<g> left open'],
      [svgWith('<!-- a -- b -->'), 'a comment holding --'],
      ['', 'no <svg> element'],
    ];
    for (const [svg, why] of refused) expect([svg, inertSvg(svg)]).toEqual([svg, { ok: false, why }]);
  });

  it('refuses bytes that are not what their type says, and every type but PNG and SVG', () => {
    expect(imageOnly('image/png', Buffer.from('<html><script>alert(1)</script></html>'))).toEqual({ ok: false, why: 'it does not start with the PNG signature' });
    expect(imageOnly('image/svg+xml', Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe]))).toEqual({ ok: false, why: 'it is not UTF-8 text' });
    expect(imageOnly('text/html', Buffer.from('<p>x</p>'))).toEqual({ ok: false, why: 'text/html is not an image type the board shows' });
    expect(imageOnly('image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))).toEqual({ ok: false, why: 'image/jpeg is not an image type the board shows' });
    expect(imageOnly('image/svg+xml', Buffer.alloc(5 * 1024 * 1024, 0x20))).toEqual({ ok: false, why: 'it is larger than 4 MB' });
  });
});
