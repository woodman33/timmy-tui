/**
 * R11 round 5 (H174): the Rive components' assets (src/companion/rive-assets.ts) over real HTTP on 127.0.0.1: the listing
 * (GET /api/rive/assets: each component with its .riv when there — name, bytes, sha256 short — its editable sources by name
 * and its rive.yaml meta), the files by exact name (GET /assets/rive/<component>/<file>), 404 in words for a file or a
 * component that is not there (no path of this computer), nothing for a path, a dot segment or another extension; the guards
 * given are applied to the listing. The repo's own folders (welcome, connection, activity) list their source and NO .riv —
 * the compile path is the operator's Rive tooling, not this container's — said so. A FAKE .riv (bytes the test writes, labelled
 * FAKE; nothing is compiled) exercises the with-.riv branch in a temp folder.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MARK_ABSENT, markDir } from '../src/companion/page.js';
import { listRiveComponents, mountRiveAssets, readRiveMeta, RIVE_ASSET_ABSENT, RIVE_COMPONENT_ABSENT, RIVE_NO_RIV, RIVE_WITH_RIV, riveAssetsDir, riveRuntimeHere } from '../src/companion/rive-assets.js';

function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += String(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: body.replace(/\n$/, '') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const listen = (app: express.Express): Promise<{ server: Server; port: number }> => new Promise((resolve) => {
  const server = createServer(app);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
});

describe('the Rive components\' assets (R11 round 5, H174)', () => {
  let temp = '';
  let markTemp = '';
  let fake: { server: Server; port: number };
  let repo: { server: Server; port: number };
  const FAKE_RIV = Buffer.from('FAKE .riv bytes written by tests/companion-rive-assets.test.ts: not a compiled Rive file');
  beforeAll(async () => {
    temp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'h174-rive-assets-'));
    mkdirSync(join(temp, 'welcome'), { recursive: true });
    writeFileSync(join(temp, 'welcome', 'welcome.riv'), FAKE_RIV);
    writeFileSync(join(temp, 'welcome', 'scene.rml'), '<Rive version="1" kind="fragment"></Rive>\n');
    writeFileSync(join(temp, 'welcome', 'rive.yaml'), 'name: welcome\nartboard: TimmyWelcome\nstateMachine: Welcome\ninputs: welcome, selected, expanded\nlogs:\n  file: build/rive.log\n');
    writeFileSync(join(temp, 'welcome', 'README.md'), '# FAKE component folder (a test)\n');
    writeFileSync(join(temp, 'welcome', 'notes.bin'), 'not served: another extension\n');
    mkdirSync(join(temp, 'Bad Name'), { recursive: true });
    writeFileSync(join(temp, 'loose.riv'), FAKE_RIV);
    // the listing behind a guard: a header the test's guard asks for
    const guarded = express();
    const withToken: express.RequestHandler = (req, res, next) => { if (req.headers.authorization === 'Bearer test-token') next(); else res.status(401).json({ ok: false, error: 'the test\'s guard refused' }); };
    // the T mark's facts travel with the listing (a FAKE mark folder with the file; the companion's own folder on `own`)
    const markTemp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'h174-rive-mark-')); // outside the components' folder
    writeFileSync(join(markTemp, 'timmy-mark.riv'), FAKE_RIV);
    mountRiveAssets(guarded, { withToken, dir: temp, markDir: markTemp });
    guarded.use((_req, res) => { res.status(404).type('text/plain').send('nothing here'); });
    fake = await listen(guarded);
    const own = express();
    mountRiveAssets(own);
    own.use((_req, res) => { res.status(404).type('text/plain').send('nothing here'); });
    repo = await listen(own);
  });
  afterAll(async () => {
    await new Promise((r) => fake?.server.close(() => r(undefined)));
    await new Promise((r) => repo?.server.close(() => r(undefined)));
    if (temp) rmSync(temp, { recursive: true, force: true });
  });

  it('lists each component with its .riv (name, bytes, sha256 short), its sources by name and its rive.yaml meta; the listing is behind the guard', async () => {
    const refused = await raw(fake.port, '/api/rive/assets');
    expect(refused.status).toBe(401);
    const r = await raw(fake.port, '/api/rive/assets', { Authorization: 'Bearer test-token' });
    expect(r.status).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.ok).toBe(true);
    expect(typeof b.runtime).toBe('boolean');
    expect(b.runtime).toBe(riveRuntimeHere());
    expect(b.components.map((c: { component: string }) => c.component)).toEqual(['welcome']); // 'Bad Name' and loose.riv are not components
    const w = b.components[0];
    expect(w.riv).toEqual({ name: 'welcome.riv', bytes: FAKE_RIV.length, sha256: createHash('sha256').update(FAKE_RIV).digest('hex').slice(0, 12) });
    expect(w.sources).toEqual(['README.md', 'rive.yaml', 'scene.rml']); // notes.bin is not a source
    expect(w.meta).toEqual({ name: 'welcome', artboard: 'TimmyWelcome', stateMachine: 'Welcome', inputs: ['welcome', 'selected', 'expanded'] });
    expect(w.words).toBe(RIVE_WITH_RIV);
    expect(r.body).not.toContain(temp);
    // R11 round 7: the mark's facts in the listing — the Studio serves no /assets/mark.json, and asking it was the 404 after placeRive
    expect(b.mark).toEqual({ riv: true, words: 'The T mark is drawn by its Rive file.' });
    const ownListing = JSON.parse((await raw(repo.port, '/api/rive/assets')).body);
    expect(ownListing.mark).toEqual({ riv: existsSync(join(markDir(), 'timmy-mark.riv')), words: existsSync(join(markDir(), 'timmy-mark.riv')) ? 'The T mark is drawn by its Rive file.' : MARK_ABSENT });
  });

  it('serves a component\'s files by exact name with their types; 404 in words for a missing file or component; nothing for a path, a dot segment or another extension', async () => {
    const riv = await raw(fake.port, '/assets/rive/welcome/welcome.riv');
    expect(riv.status).toBe(200);
    expect(riv.type).toContain('application/octet-stream');
    expect(riv.body).toBe(FAKE_RIV.toString());
    const rml = await raw(fake.port, '/assets/rive/welcome/scene.rml');
    expect(rml.status).toBe(200);
    expect(rml.type).toContain('text/plain');
    const yaml = await raw(fake.port, '/assets/rive/welcome/rive.yaml');
    expect(yaml.status).toBe(200);
    const md = await raw(fake.port, '/assets/rive/welcome/README.md');
    expect(md.status).toBe(200);
    expect(md.type).toContain('text/markdown');
    const missing = await raw(fake.port, '/assets/rive/welcome/other.riv');
    expect(missing.status).toBe(404);
    expect(missing.body).toBe(RIVE_ASSET_ABSENT);
    const noComponent = await raw(fake.port, '/assets/rive/activity/activity.riv');
    expect(noComponent.status).toBe(404);
    expect(noComponent.body).toBe(RIVE_COMPONENT_ABSENT);
    for (const p of ['/assets/rive/welcome/notes.bin', '/assets/rive/welcome/../loose.riv', '/assets/rive/%2e%2e/loose.riv', '/assets/rive/welcome/a/b.riv', '/assets/rive/Bad%20Name/x.riv', '/assets/rive/welcome/.hidden.riv']) {
      const r = await raw(fake.port, p);
      expect(r.status, p).toBe(404);
      expect(r.body, p).toBe('nothing here'); // fell through to the server's own 404, not the assets' words
      expect(r.body).not.toContain(temp);
    }
  });

  it('the repo\'s own folders: timmy-ui lists the operator\'s .riv (its sha256) with its editable source, the font\'s license among them; welcome, connection and activity list their drafted source and NO .riv, with their artboard and state machine', async () => {
    const r = await raw(repo.port, '/api/rive/assets');
    expect(r.status).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.components.map((c: { component: string }) => c.component)).toEqual(['activity', 'connection', 'timmy-ui', 'welcome']);
    const native = b.components.find((c: { component: string }) => c.component === 'timmy-ui');
    expect(native.riv).toEqual({ name: 'timmy-ui.riv', bytes: 405278, sha256: '9fd9ae7c0981' });
    expect(native.sources).toEqual(['OFL.txt', 'README.md', 'create-controls.py', 'rive.yaml', 'scene.rml']); // Montserrat.ttf is kept, not served
    expect(native.meta).toMatchObject({ artboard: 'AgentConsole', artboards: ['AgentConsole', 'ProviderCard', 'ActionButton'], stateMachine: 'TimmyUI', inputs: ['State', 'Hover', 'Pressed', 'ReducedMotion'] });
    expect(native.words).toBe(RIVE_WITH_RIV);
    const ttf = await raw(repo.port, '/assets/rive/timmy-ui/Montserrat.ttf');
    expect(ttf.status).toBe(404);
    expect(ttf.body).toBe('nothing here');
    const nativeRiv = await raw(repo.port, '/assets/rive/timmy-ui/timmy-ui.riv');
    expect(nativeRiv.status).toBe(200);
    expect(nativeRiv.type).toContain('application/octet-stream');
    for (const c of b.components.filter((x: { component: string }) => x.component !== 'timmy-ui')) {
      expect(c.riv, c.component).toBeNull();
      expect(c.sources, c.component).toEqual(['README.md', 'rive.yaml', 'scene.rml']);
      expect(c.words).toBe(RIVE_NO_RIV);
      expect(c.meta.inputs).toContain('selected');
      expect(c.meta.inputs).toContain('expanded');
    }
    const byName = Object.fromEntries(b.components.map((c: { component: string; meta: Record<string, unknown> }) => [c.component, c.meta]));
    expect(byName.welcome).toMatchObject({ artboard: 'TimmyWelcome', stateMachine: 'Welcome' });
    expect(byName.connection).toMatchObject({ artboard: 'TimmyConnection', stateMachine: 'Connection' });
    expect(byName.activity).toMatchObject({ artboard: 'TimmyActivity', stateMachine: 'Activity' });
    expect(byName.welcome.inputs).toContain('welcome');
    expect(byName.connection.inputs).toContain('connection');
    expect(byName.activity.inputs).toContain('activity');
    expect(b.words).toMatch(/The components with a \.riv are drawn by the runtime|runtime is not installed/);
    // the sources are served; the .riv is a 404 in words
    const rml = await raw(repo.port, '/assets/rive/connection/scene.rml');
    expect(rml.status).toBe(200);
    expect(rml.body).toContain('name="TimmyConnection"');
    expect(rml.body).toContain('StateMachineNumber name="connection"');
    const riv = await raw(repo.port, '/assets/rive/connection/connection.riv');
    expect(riv.status).toBe(404);
    expect(riv.body).toBe(RIVE_ASSET_ABSENT);
    // the pure readers agree with the routes
    expect(listRiveComponents(riveAssetsDir()).map((c) => c.component)).toEqual(['activity', 'connection', 'timmy-ui', 'welcome']);
    expect(readRiveMeta(join(riveAssetsDir(), 'activity', 'rive.yaml')).inputs).toEqual(['activity', 'selected', 'expanded']);
    expect(listRiveComponents(join(temp, 'none-here'))).toEqual([]);
  });
});
