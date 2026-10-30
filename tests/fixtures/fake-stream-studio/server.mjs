// FAKE Stream Studio (tests, labelled): a test double shaped like the owner's server (timmy-stream-studio server.mjs) as Timmy
// hosts it — PORT + STREAM_DATA_DIR; POST /api/assets/image (the image's bytes, its content type), POST /api/jobs { scene,
// format: html | svg, time } → 202 { id, status: queued }, GET /api/jobs (and /:id), POST /api/jobs/:id/cancel, artifacts at
// /api/artifacts/:id/:name. An export takes ~900 ms (so a cancel can land); a scene named FAIL fails. It checks the scene's
// frame (960 × 600) and that its image layer names an imported asset. Its "player" is FAKE HTML; nothing is rendered.
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const port = Number(process.env.PORT);
const data = process.env.STREAM_DATA_DIR;
mkdirSync(join(data, 'jobs'), { recursive: true });
const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dist', 'index.html'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const assets = new Map(); const jobs = new Map(); const files = new Map();
const body = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
const view = (j) => ({ id: j.id, status: j.status, progress: j.progress, format: j.format, error: j.error, artifacts: j.status === 'succeeded' ? j.artifacts : [] });
const persist = (j) => { mkdirSync(join(data, 'jobs', j.id), { recursive: true }); writeFileSync(join(data, 'jobs', j.id, 'job.json'), JSON.stringify(view(j))); };
http.createServer(async (req, res) => {
  const send = (s, v, type = 'application/json') => { res.writeHead(s, { 'content-type': type }); res.end(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)); };
  if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Use the local Stream Studio address.' });
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  if (p === '/') return send(200, page, 'text/html');
  if (p === '/api/health') return send(200, { service: 'timmy-stream-studio', fake: true, broadcast: 'not-built' });
  if (req.method === 'POST' && p === '/api/assets/image') {
    const b = await body(req); const id = sha(b);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(req.headers['content-type']))) return send(415, { error: 'Import a PNG, JPEG or WebP with its matching content type.' });
    assets.set(id, b); return send(201, { id, sha256: id, bytes: b.length, mime: req.headers['content-type'], name: String(req.headers['x-file-name'] || 'image') });
  }
  if (p === '/api/jobs' && req.method === 'GET') return send(200, [...jobs.values()].map(view));
  if (p === '/api/jobs' && req.method === 'POST') {
    const b = JSON.parse((await body(req)).toString() || '{}'); const s = b.scene || {};
    if (s.width !== 960 || s.height !== 600) return send(400, { error: 'This milestone uses a 960 × 600 frame.' });
    if (!['html', 'svg'].includes(b.format)) return send(400, { error: 'Supported exports are SVG frame and HTML player.' });
    for (const l of s.layers || []) if (l.type === 'image' && !assets.has(l.assetId)) return send(404, { error: 'Image asset not found.' });
    const j = { id: randomUUID(), status: 'queued', progress: 0, format: b.format, artifacts: [] }; jobs.set(j.id, j); persist(j);
    setTimeout(() => { if (j.status !== 'queued') return; j.status = 'running'; j.progress = 10; persist(j); }, 150);
    setTimeout(() => {
      if (j.status !== 'running') return;
      if (s.name === 'FAIL') { j.status = 'failed'; j.error = 'FAKE export failure'; persist(j); return; }
      const out = b.format === 'svg' ? [['frame.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#050607"/></svg>`, 'image/svg+xml']]
        : [['index.html', `<!doctype html><html><body style="background:#050607;color:#F1F3F5"><p id="out">FAKE Stream Studio player · ${s.layers?.[0]?.motion ?? ''}</p></body></html>`, 'text/html']];
      out.push(['scene.json', JSON.stringify(s), 'application/json']);
      j.artifacts = out.map(([name, text, mime]) => { const bytes = Buffer.from(text); files.set(`${j.id}/${name}`, [bytes, mime]); return { name, url: `/api/artifacts/${j.id}/${name}`, bytes: bytes.length, sha256: sha(bytes), mime }; });
      j.status = 'succeeded'; j.progress = 100; persist(j);
    }, 900);
    return send(202, view(j));
  }
  const m = /^\/api\/jobs\/([a-f0-9-]{36})(\/cancel)?$/.exec(p);
  if (m) { const j = jobs.get(m[1]); if (!j) return send(404, { error: 'Export job not found.' }); if (m[2] && req.method === 'POST' && ['queued', 'running'].includes(j.status)) { j.status = 'cancelled'; persist(j); } return send(200, view(j)); }
  const a = /^\/api\/artifacts\/([a-f0-9-]{36})\/([\w.-]+)$/.exec(p);
  if (a && files.has(`${a[1]}/${a[2]}`)) { const [bytes, mime] = files.get(`${a[1]}/${a[2]}`); return send(200, bytes, mime); }
  return send(404, { error: 'Not found.' });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
