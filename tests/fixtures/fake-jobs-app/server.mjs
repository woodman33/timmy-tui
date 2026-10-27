// FAKE jobs app (R13 tests, labelled): a test double shaped like two owners' app servers as they ship them, chosen by the
// environment the host gives it: Film Room's (PORT + FILMROOM_DATA_DIR: jobs/<id>.json, ingest and render jobs, files at
// /api/jobs/:id/files/:name, media at /api/assets/:id/media) and Timmy Animate's (PORT + ANIMATE_DATA_DIR: <id>/job.json,
// native exports with artifacts at /api/artifacts/:id/:name). Jobs take ~400 ms, so a cancel can land; a scene named FAIL
// fails. No model, no network, no Blender, no ffmpeg: its "media" and "artifacts" are FAKE bytes.
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const port = Number(process.env.PORT);
const film = process.env.FILMROOM_DATA_DIR;
const anim = process.env.ANIMATE_DATA_DIR;
const data = film ?? anim;
mkdirSync(data, { recursive: true });
const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dist', 'index.html'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const jobs = new Map();
const save = (j) => {
  if (film) { mkdirSync(join(data, 'jobs'), { recursive: true }); writeFileSync(join(data, 'jobs', `${j.id}.json`), JSON.stringify(j)); }
  else { mkdirSync(join(data, j.id), { recursive: true }); writeFileSync(join(data, j.id, 'job.json'), JSON.stringify(j)); }
};
const assets = new Map();
const names = new Map();
// (assets persist in the data folder, as the real app's do: a later worker for the same project still has them)
const assetsDir = join(data, 'fake-assets');
if (film && existsSync(assetsDir)) for (const f of readdirSync(assetsDir).filter((x) => x.endsWith('.json'))) { const a = JSON.parse(readFileSync(join(assetsDir, f), 'utf8')); assets.set(a.id, Buffer.from(a.b64, 'base64')); names.set(a.id, a.name); }
const keepAsset = (id, name, bytes) => { mkdirSync(assetsDir, { recursive: true }); writeFileSync(join(assetsDir, `${id}.json`), JSON.stringify({ id, name, b64: bytes.toString('base64') })); };
const body = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
const server = http.createServer(async (req, res) => {
  const send = (s, v, type = 'application/json') => { res.writeHead(s, { 'content-type': type }); res.end(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)); };
  if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Unrecognized local host' });
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') return send(200, page, 'text/html');
  if (url.pathname === '/api/config' || url.pathname === '/api/health') return send(200, { fake: true, mode: film ? 'film-room' : 'animate' });
  const finish = (j, after) => setTimeout(() => { if (['cancelled'].includes(j[film ? 'state' : 'status'])) return; after(j); save(j); }, 400);
  if (film && req.method === 'POST' && url.pathname === '/api/assets') {
    const bytes = await body(req); const id = randomUUID(); const aid = randomUUID();
    const j = { id, type: 'ingest', state: 'running', progress: 0 }; jobs.set(id, j); save(j);
    finish(j, (x) => { assets.set(aid, bytes); names.set(aid, url.searchParams.get('name')); keepAsset(aid, url.searchParams.get('name'), bytes); x.state = 'complete'; x.result = { asset: { id: aid, name: url.searchParams.get('name'), sha256: sha(bytes) } }; });
    return send(202, { jobId: id });
  }
  if (film && req.method === 'GET' && url.pathname === '/api/assets') return send(200, { assets: [...assets.entries()].map(([id, b]) => ({ id, name: names.get(id), sha256: sha(b) })) });
  const media = /^\/api\/assets\/([a-f0-9-]{36})\/media$/.exec(url.pathname);
  if (film && media && assets.has(media[1])) return send(200, assets.get(media[1]), 'video/mp4');
  if (film && req.method === 'POST' && url.pathname === '/api/render-jobs') {
    const b = JSON.parse((await body(req)).toString() || '{}'); const id = randomUUID();
    // (as the real app's validateManifest: the selected asset must exist, and the manifest must name it)
    if (!assets.has(b.assetId)) return send(404, { error: 'Asset not found.' });
    if (b.manifest?.asset?.name !== names.get(b.assetId)) return send(409, { error: 'Manifest source name differs from selected asset.' });
    if (b.manifest?.asset?.id && b.manifest.asset.id !== b.assetId) return send(409, { error: 'Manifest asset ID differs from selected asset.' });
    const j = { id, type: 'render', state: 'running', progress: 0 }; jobs.set(id, j); save(j);
    finish(j, (x) => { x.state = 'complete'; x.result = { clips: (b.manifest?.clips ?? []).map((c, i) => ({ id: c.id, url: `/api/jobs/${id}/files/clip-${String(i + 1).padStart(3, '0')}.mp4` })) }; });
    return send(202, { jobId: id });
  }
  const file = /^\/api\/jobs\/([a-f0-9-]{36})\/files\/([\w.-]+)$/.exec(url.pathname);
  if (film && file) return send(200, Buffer.from(`FAKE clip ${file[2]}`), 'video/mp4');
  if (anim && req.method === 'POST' && url.pathname === '/api/jobs') {
    const b = JSON.parse((await body(req)).toString() || '{}'); const id = randomUUID();
    const j = { id, status: 'running', progress: 0, artifacts: [] }; jobs.set(id, j); save(j);
    finish(j, (x) => { if (b.scene?.name === 'FAIL') { x.status = 'failed'; x.error = 'FAKE export failure'; } else { x.status = 'succeeded'; x.artifacts = [{ name: 'scene.blend', url: `/api/artifacts/${id}/scene.blend` }, { name: 'preview.png', url: `/api/artifacts/${id}/preview.png` }]; } });
    return send(202, j);
  }
  const art = /^\/api\/artifacts\/([a-f0-9-]{36})\/([\w.-]+)$/.exec(url.pathname);
  if (anim && art) return send(200, Buffer.from(`FAKE ${art[2]}`), 'application/octet-stream');
  const jm = /^\/api\/jobs\/([a-f0-9-]{36})(\/cancel)?$/.exec(url.pathname);
  if (jm) {
    const j = jobs.get(jm[1]); if (!j) return send(404, { error: 'Job not found' });
    if (jm[2] && req.method === 'POST') { const k = film ? 'state' : 'status'; if (j[k] === 'running') { j[k] = 'cancelled'; save(j); } }
    return send(200, j);
  }
  return send(404, { error: 'Route not found' });
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
