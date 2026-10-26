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
const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dist', 'index.html'));
const server = http.createServer((req, res) => {
  const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'" }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Unrecognized local host' });
  if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return send(403, { error: 'Cross-origin requests are not allowed' });
  if (req.url === '/api/state') return send(200, { fake: true, dataDir: data });
  if (req.url === '/api/env') return send(200, { keys: Object.keys(process.env).sort(), cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null, origin: req.headers.origin ?? null });
  if (req.method === 'POST' && req.url === '/api/echo') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => send(200, { echoed: b })); return; }
  if (req.url === '/') return send(200, page.toString(), 'text/html');
  return send(404, { error: 'Route not found' });
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => { writeFileSync(join(data, 'stopped.json'), JSON.stringify({ at: Date.now() })); server.close(() => process.exit(0)); });
