// A LABELLED FAKE of Card Lab's server for tests/miniapps-handoff.test.ts: its health, and POST /api/runs as the owner's
// backend/core.mjs create() answers it (one to four base64 PNG/JPEG/WebP images, each kept with its sha256, the run 201), and
// its page at / naming the run its address asks for (?run=, as the owner's app reads it), for the app's browser test.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

const port = Number(process.env.CARDLAB_PORT);
const data = process.env.CARDLAB_DATA_DIR;
mkdirSync(data, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
http.createServer((req, res) => {
  const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (req.method === 'GET' && req.url === '/api/health') return json(200, { status: 'ok', fake: true });
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    const run = new URL(req.url, 'http://x').searchParams.get('run') || '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // (the owner's theme interface v1, as its app side reads it: ?theme= first, then timmy:theme messages from the parent)
    // like Card Lab 6f166d2d: the exact parent origin is the server's (CARDLAB_TIMMY_PARENT_ORIGIN), never the launch query's
    const probe = "<script>const HOST=" + JSON.stringify(process.env.CARDLAB_TIMMY_PARENT_ORIGIN || '') + ";const q=new URLSearchParams(location.search),b=document.body;b.dataset.initialTheme=q.get('theme')||'';b.dataset.hostOrigin=HOST;addEventListener('message',e=>{const d=e.data;if(e.source!==parent||e.origin!==HOST||!d||d.type!=='timmy:theme'||d.version!==1)return;b.dataset.theme=d.theme;b.dataset.themeFrom=e.origin;b.dataset.themeCount=String(Number(b.dataset.themeCount||0)+1)})</script>";
    res.end(`<!doctype html><title>FAKE Card Lab</title><body><p>A LABELLED FAKE of Card Lab.</p><p data-fake-run="${/^card_[a-f0-9-]{36}$/.test(run) ? run : ''}">${/^card_[a-f0-9-]{36}$/.test(run) ? `Inspection ${run}` : 'No run asked for'}</p>${probe}</body>`);
    return undefined;
  }
  if (req.method === 'POST' && req.url === '/api/runs') {
    let b = ''; req.setEncoding('utf8'); req.on('data', (c) => { b += c; });
    req.on('end', () => {
      let input; try { input = JSON.parse(b); } catch { return json(400, { error: 'not JSON' }); }
      const img = input.images?.[0];
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(img?.dataUrl || '');
      if (!m) return json(400, { error: 'Only base64 JPEG, PNG and WebP images are supported' });
      const bytes = Buffer.from(m[2], 'base64');
      const id = `card_${randomUUID()}`;
      mkdirSync(join(data, id), { recursive: true });
      const kept = bytes;
      const run = { version: 1, id, status: 'ready', stage: 'intent', images: [{ id: 'image_0', name: img.name, view: img.view, mime: m[1], sha256: sha(kept), bytes: kept.length }], events: [] };
      writeFileSync(join(data, id, 'run.json'), JSON.stringify(run));
      return json(201, run);
    });
    return undefined;
  }
  return json(404, { error: 'Route not found' });
}).listen(port, '127.0.0.1');
