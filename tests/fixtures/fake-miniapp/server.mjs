// FAKE mini-app (R13 tests): a labelled test double of an owner's standalone app server, shaped like Model Studio's
// server.mjs as its owner ships it: it answers only its own loopback Host, refuses another Origin, sends
// frame-ancestors 'none', takes STUDIO_PORT and STUDIO_DATA_DIR, and stops on SIGTERM. It never calls a model or a network.
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const port = Number(process.env.STUDIO_PORT);
const data = process.env.STUDIO_DATA_DIR;
mkdirSync(data, { recursive: true });
writeFileSync(join(data, 'started.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
// jobs persist in the data folder and are reported again after a restart (as Model Studio replays its saved state)
const jobsFile = join(data, 'jobs.json');
let jobs = []; try { jobs = JSON.parse(readFileSync(jobsFile, 'utf8')); } catch { jobs = []; }
const keep = () => writeFileSync(jobsFile, JSON.stringify(jobs));
const assets = new Map();
const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dist', 'index.html'));
const server = http.createServer((req, res) => {
  const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'x-frame-options': 'SAMEORIGIN' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Unrecognized local host' });
  if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return send(403, { error: 'Cross-origin requests are not allowed' });
  if (req.url === '/api/state') return send(200, { fake: true, dataDir: data, jobs: [...jobs].reverse() });
  // FAKE job: ends at once, succeeded, with a FAKE file the app serves (or failed, when asked)
  if (req.method === 'POST' && req.url === '/api/jobs') {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const body = JSON.parse(b || '{}'); const id = `job_fake_${jobs.length + 1}`;
      if (body.fail) { const j = { id, kind: 'create', status: 'failed', engine: 'fake', error: 'FAKE failure' }; jobs.push(j); keep(); return send(202, j); }
      if (body.cancel) { const j = { id, kind: 'create', status: 'cancelled', engine: 'fake' }; jobs.push(j); keep(); return send(202, j); }
      const asset = { id: `asset_fake_${jobs.length + 1}`, previewFilename: 'r1-model.glb', nativeFilename: 'r1-model.blend' };
      assets.set(`${asset.id}/r1-model.glb`, Buffer.from('FAKE glb bytes')); assets.set(`${asset.id}/r1-model.blend`, Buffer.from('FAKE blend bytes'));
      const j = { id, kind: 'create', status: 'succeeded', engine: 'fake', result: { asset } }; jobs.push(j); keep(); send(202, j);
    }); return;
  }
  const am = /^\/api\/assets\/([\w-]+)\/([\w.-]+)$/.exec(req.url ?? '');
  if (am && assets.has(`${am[1]}/${am[2]}`)) {
    const bytes = assets.get(`${am[1]}/${am[2]}`);
    const r = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
    if (r) { const a = Number(r[1]), b = Math.min(Number(r[2]), bytes.length - 1); res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': `bytes ${a}-${b}/${bytes.length}` }); return res.end(bytes.subarray(a, b + 1)); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(bytes);
  }
  if (req.url === '/api/env') return send(200, { keys: Object.keys(process.env).sort(), cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null, origin: req.headers.origin ?? null });
  if (req.method === 'POST' && req.url === '/api/echo') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => send(200, { echoed: b })); return; }
  if (req.url === '/') return send(200, page.toString(), 'text/html');
  return send(404, { error: 'Route not found' });
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => { writeFileSync(join(data, 'stopped.json'), JSON.stringify({ at: Date.now() })); server.close(() => process.exit(0)); });
