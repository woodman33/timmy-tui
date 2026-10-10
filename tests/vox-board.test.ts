// Timmy VoxVision on the board (round R4, helper H49): each record's card is checked against its vox receipt before
// anything on it is drawn as measured (verified, stale, unverified); every string from a record is escaped on the
// snapshot and on the live board; the live board's VoxVision actions take exact shapes only, run as the typed command;
// and its /file route serves only a verified record's highlight, with the token. Timmy's STL reader is real here; the
// Look worker in the last test is a FAKE (tests/helpers/vox-fakes.ts), not OpenCV.
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVoxAction, readVoxRecord, voxFileFor, voxSection, type BoardVox } from '../src/repl/board-vox.js';
import { kit as boardKit } from '../src/repl/board-kit.js';
import { renderBoard, renderBoardBody } from '../src/repl/board.js';
import { resetLookChecks } from '../src/vision/look.js';
import type { Receipt } from '../src/utils/receipts.js';
import { cubeStl, fakeTools, png, put, settled, sha, tempKit, text, workspace } from './helpers/vox-fakes.js';

const kit = tempKit();
afterEach(async () => { resetLookChecks(); await kit.cleanup(); });

/** A project with one /inspect record of an STL (Timmy's own reader, in process), and its receipts. */
async function stlRecord() {
  const root = kit.temp('vox-board-');
  put(root, 'models/cube.stl', cubeStl(1));
  const w = workspace(root, kit);
  await w.ws.inspect('models/cube.stl');
  const chain = w.sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i + 1).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[];
  const rec = w.sealed[0].outputs![0].path;
  return { root, rec, chain, ...w };
}

describe('a card is checked against its receipt', () => {
  it('verified, then unverified once the record is edited, then stale once its input changes', async () => {
    const { root, rec, chain } = await stlRecord();
    const read = () => readVoxRecord({ root, file: rec, text: readFileSync(join(root, rec), 'utf8'), fileSha256: sha(readFileSync(join(root, rec))), chain });
    const ok = read()!;
    expect(ok.check).toEqual({ status: 'verified', receipt: '00000001', reasons: [] });
    expect(ok.highlights.map((h) => [h.type, h.shown])).toEqual([['bbox-svg', true]]);
    // Its input changed: stale, said with both hashes.
    put(root, 'models/cube.stl', cubeStl(2));
    const stale = read()!;
    expect(stale.check.status).toBe('stale');
    expect(stale.check.reasons[0]).toMatch(/^models\/cube\.stl changed since \(sha256 [0-9a-f]{12} now, [0-9a-f]{12} measured\)$/);
    // The record edited after its receipt: unverified, and its highlight is not drawn.
    put(root, 'models/cube.stl', cubeStl(1));
    const text0 = readFileSync(join(root, rec), 'utf8');
    writeFileSync(join(root, rec), text0.replace('"value": 12', '"value": 13'));
    const edited = read()!;
    expect(edited.check.status).toBe('unverified');
    expect(edited.check.reasons[0]).toContain('it was changed after it was written');
    expect(edited.highlights.every((h) => !h.shown && h.why === 'the record is not verified')).toBe(true);
    // No receipt at all.
    writeFileSync(join(root, rec), text0);
    expect(readVoxRecord({ root, file: rec, text: text0, fileSha256: sha(text0), chain: [] })!.check).toEqual({ status: 'unverified', reasons: ['no vox receipt on the runs chain sealed this record'] });
    // A highlight whose bytes changed is not drawn, and the card says why.
    const svg = ok.highlights[0].path;
    writeFileSync(join(root, svg), readFileSync(join(root, svg), 'utf8').replace('</svg>', '<!-- x --></svg>'));
    expect(read()!.highlights[0]).toMatchObject({ shown: false, why: 'its file is not the bytes the record and its receipt name' });
  });

  it('the workspace\'s snapshot board shows the card verified, with its SVG, DOCTRINE §15, the command, and no record as an output', async () => {
    const { ws, root, rec } = await stlRecord();
    ws.board('');
    const html = readFileSync(join(root, '.timmy/board/index.html'), 'utf8');
    expect(html).toContain('<h2 id="voxvision">VoxVision <span class="count">1</span></h2>');
    expect(html).toContain('<a href="#voxvision">VoxVision <b>1</b></a>');
    expect(html).toContain('<strong>verified</strong>');
    const id = rec.slice('results/vox/'.length, -'.json'.length);
    expect(html).toContain(`<img src="../../results/vox/${id}/bbox.svg"`);
    expect(html).toContain('Timmy&#39;s own reading of the STL');
    expect(html).toContain('Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.');
    expect(html).toContain('data-cmd="/inspect models/cube.stl"');
    expect(html).not.toMatch(/<h3 id="outputs">Outputs <span class="count">[1-9]/);
    // The tools panel says each tool's state; the files panel offers the STL with its commands.
    expect(html).toContain("Timmy&#39;s STL reader</strong> <span class=\"vox-badge vox-badge-ok\">built in</span>");
    expect(html).toMatch(/the STEP readback \(OCP\)<\/strong> <span class="vox-badge vox-badge-warn">needs setup<\/span>/);
    expect(html).toContain('set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery');
  });
});

describe('every string from a record is escaped', () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const card = (): BoardVox => ({
    tools: [{ tool: 'look', name: `Look ${XSS}`, reads: 'images', state: 'needs setup', detail: XSS, setup: XSS }],
    files: [{ rel: `refs/${XSS}.png`, kind: 'image' }, { rel: 'refs/b.png', kind: 'image' }],
    filesMore: 0, more: 0,
    cards: [{
      file: 'results/vox/v00000001.json', id: 'v00000001', action: XSS, command: `/inspect "${XSS}"`, madeAt: XSS, status: XSS,
      inputs: [{ path: `refs/${XSS}.png`, sha256: XSS, kind: 'image', kind_by: 'bytes', note: XSS }],
      tools: [{ tool: 'look', name: XSS, version: XSS, engine: XSS, ran: 'job', job: XSS, raw: `.timmy/vox/v00000001/${XSS}.log` }],
      metrics: [{ name: 'mean_color', title: XSS, value: { hex: '#ff0000' }, method: XSS, tier: XSS, label: XSS, measured_by: XSS, note: XSS },
        { name: 'qr_codes_decoded', title: 'QR', value: [{ text: XSS }], method: 'm', tier: 'deterministic computation', label: 'l', measured_by: 'b' },
        { name: XSS, title: XSS, value: XSS, unit: XSS, method: XSS, tier: 'deterministic computation', label: XSS, measured_by: XSS, of: XSS }],
      claims: [{ name: 'roboflow_predictions', title: XSS, value: [{ class: XSS }], tier: 'model prediction', label: XSS, measured_by: XSS }],
      highlights: [{ path: `results/vox/v00000001/${XSS}.png`, sha256: XSS, type: XSS, drawn_from: [XSS], drawn_by: XSS, method: XSS, shown: true }],
      failures: [{ tool: XSS, code: 'needs-setup', message: XSS, setup: XSS }, { tool: XSS, code: XSS, message: XSS }],
      notes: [XSS], doctrine: true, check: { status: 'stale', reasons: [XSS] },
    }],
  });

  for (const live of [false, true]) {
    it(`on the ${live ? 'live board' : 'snapshot'}`, () => {
      const { html, toc } = voxSection(card(), { kit: boardKit({ live, base: '../../' }), base: '../../' });
      const all = toc + html;
      expect(all).not.toContain('<img src=x');
      expect(all).not.toContain('onerror=alert(1)>');
      expect(all).toContain('&lt;img src=x onerror=alert(1)&gt;');
      // Only the elements VoxVision draws: its own <img> for the highlight, none from a string.
      expect((all.match(/<img /g) ?? []).length).toBe(1);
      if (live) {
        // The live page allows no style attribute: swatches are data for its script; the highlight is fetched by its script.
        expect(all).not.toMatch(/\sstyle="/);
        expect(all).toContain('data-swatch="#ff0000"');
        expect(all).toContain(`<img data-vox-src="results/vox/v00000001/&lt;img src=x onerror=alert(1)&gt;.png"`);
        expect(all).toContain('data-act="vox" data-verb="inspect" data-file="refs/&lt;img src=x onerror=alert(1)&gt;.png"');
        expect(all).toContain('<select class="vox-in" data-vox-other');
      } else {
        expect(all).toContain('src="../../results/vox/v00000001/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.png"');
        expect(all).not.toContain('data-act=');
      }
    });
  }

  it('a malformed record is kept out, and a board without VoxVision is drawn as before', () => {
    expect(readVoxRecord({ root: '/nonexistent', file: 'results/vox/v00000001.json', text: '{"schema":"other"}', chain: [] })).toBeNull();
    expect(readVoxRecord({ root: '/nonexistent', file: 'results/vox/v00000001.json', text: 'not json', chain: [] })).toBeNull();
    const input = { project: 'p', madeAt: 'now', base: '../../', references: [], workflows: [], jobs: [], outputs: [], observations: [] };
    expect(renderBoardBody(input).main).not.toContain('voxvision');
    expect(renderBoard(input)).not.toContain('id="voxvision"');
  });
});

describe('the live board\'s VoxVision actions', () => {
  const files = [{ rel: 'refs/a.png', kind: 'image' }, { rel: 'refs/b.png', kind: 'image' }, { rel: 'clip.mp4', kind: 'video' }, { rel: 'm/cube.stl', kind: 'stl' }, { rel: 'refs/my photo.png', kind: 'image' }];
  it('take exact shapes, files the board offers, and stand for the typed command', () => {
    expect(checkVoxAction({ action: 'vox', verb: 'inspect', file: 'refs/a.png' }, files)).toEqual({ ok: true, command: { name: 'inspect', args: 'refs/a.png', line: '/inspect refs/a.png' } });
    expect(checkVoxAction({ action: 'vox', verb: 'measure', file: 'refs/my photo.png' }, files)).toEqual({ ok: true, command: { name: 'measure', args: '"refs/my photo.png"', line: '/measure "refs/my photo.png"' } });
    expect(checkVoxAction({ action: 'vox', verb: 'compare', file: 'refs/a.png', other: 'refs/b.png' }, files)).toMatchObject({ ok: true, command: { line: '/compare refs/a.png refs/b.png' } });
    expect(checkVoxAction({ action: 'vox', verb: 'detect', file: 'clip.mp4', color: '255,0,0', at: '0,1.5' }, files)).toMatchObject({ ok: true, command: { line: '/detect clip.mp4 color 255,0,0 --at 0,1.5' } });
    expect(checkVoxAction({ action: 'vox', verb: 'detect', file: 'refs/a.png' }, files)).toMatchObject({ ok: true, command: { line: '/detect refs/a.png' } });
    const refused: Array<[Record<string, unknown>, number]> = [
      [{ action: 'vox', verb: 'erase', file: 'refs/a.png' }, 400],
      [{ action: 'vox', verb: 'inspect', file: 'refs/a.png', extra: 1 }, 400],
      [{ action: 'vox', verb: 'inspect', file: 'refs/secret.png' }, 404],
      [{ action: 'vox', verb: 'compare', file: 'refs/a.png', other: 'm/cube.stl' }, 409],
      [{ action: 'vox', verb: 'compare', file: 'refs/a.png', other: 'refs/a.png' }, 409],
      [{ action: 'vox', verb: 'detect', file: 'm/cube.stl' }, 409],
      [{ action: 'vox', verb: 'detect', file: 'clip.mp4' }, 422],
      [{ action: 'vox', verb: 'detect', file: 'clip.mp4', color: '300,0,0' }, 422],
      [{ action: 'vox', verb: 'detect', file: 'refs/a.png', color: '1,2,3', at: '0' }, 422],
      [{ action: 'vox', verb: 'detect', file: 'clip.mp4', color: '1,2,3', at: '0; rm -rf /' }, 422],
      [{ action: 'vox', verb: 'inspect', file: 'refs/a.png\n' }, 400],
    ];
    for (const [body, status] of refused) expect([body, checkVoxAction(body, files)]).toEqual([body, expect.objectContaining({ ok: false, status })]);
  });

  it('/file serves a verified highlight with the token, and nothing else', async () => {
    const { ws, root, chain, rec } = await stlRecord();
    const id = rec.slice('results/vox/'.length, -'.json'.length);
    const svg = `results/vox/${id}/bbox.svg`;
    expect(voxFileFor({ root, path: svg, chain })?.type).toBe('image/svg+xml');
    expect(voxFileFor({ root, path: svg, chain: [] })).toBeNull();
    expect(voxFileFor({ root, path: rec, chain })).toBeNull();
    expect(voxFileFor({ root, path: `results/vox/${id}/../../models/cube.stl`, chain })).toBeNull();
    await ws.boardLive('live');
    const { port, url } = ws.liveBoard!;
    const token = url.split('#t=')[1];
    const get = (path: string, auth?: string): Promise<{ status: number; type: string; body: Buffer }> => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    expect((await get(`/file?p=${encodeURIComponent(svg)}`)).status).toBe(401);
    const ok = await get(`/file?p=${encodeURIComponent(svg)}`, token);
    expect([ok.status, ok.type]).toEqual([200, 'image/svg+xml']);
    expect(sha(ok.body)).toBe(sha(readFileSync(join(root, svg))));
    expect((await get(`/file?p=${encodeURIComponent('models/cube.stl')}`, token)).status).toBe(404);
    expect((await get(`/file?p=${encodeURIComponent(rec)}`, token)).status).toBe(404);
    const page = await get('/');
    expect(page.body.toString()).toContain('var TimmyVox');
  });

  it('an Inspect posted to /action runs /inspect through the workspace, echoed as from the board', async () => {
    const root = kit.temp('vox-board-live-');
    put(root, 'refs/photo.png', png(4, 2, () => [200, 10, 10]));
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws, notes, sealed } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look } });
    await ws.boardLive('live');
    const { port, url } = ws.liveBoard!;
    const token = url.split('#t=')[1];
    const body = JSON.stringify({ action: 'vox', verb: 'inspect', file: 'refs/photo.png' });
    const out = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/action', method: 'POST', headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => {
        let t = '';
        res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
      });
      req.on('error', reject);
      req.end(body);
    });
    expect(out.status).toBe(200);
    expect(out.text.split('\n')[0]).toBe('board /inspect refs/photo.png');
    expect(out.text).toMatch(/VoxVision {2}v[0-9a-f]{8} {2}inspect refs\/photo\.png/);
    expect(notes).toContain('  board  /inspect refs/photo.png');
    await settled(ws);
    expect(sealed.filter((r) => r.kind === 'vox').map((r) => r.subject)).toEqual(['vox · inspect · refs/photo.png · ok']);
    expect(text([[{ text: out.text }]])).not.toContain(root);
  });
});
